# Architecture

This document records the approved architecture decisions for the team MCP gateway. It is the source of truth for design. If a decision is not written here, it has not been made.

Status: decisions 1 to 14 approved. Two decisions are still open and are listed at the end.

## Overview

A WooCommerce store runs on Kubernetes. A gateway sits in front of several MCP servers, the first of which exposes the store. Team members reach every MCP server through the gateway only, either from an external MCP client or from the chat agent in the dashboard.

```text
                     Browser / external MCP client
                                  |
                           +------+------+
                           |   Ingress   |      only two hosts are public
                           +--+-------+--+
                  store host  |       |  gateway host (dashboard, /api, /mcp)
                              |       |
 namespace: store             |       |        namespace: gateway
 +----------------------+     |       |      +---------------------------+
 | wordpress (PVC)   <--+-----+       +----->| dashboard (React, nginx)  |
 | mariadb   (PVC)      |                    | gateway backend           |
 +----------^-----------+                    | postgres (PVC)            |
            | WooCommerce REST API           +-------------+-------------+
            |                                              | MCP, Streamable HTTP
 namespace: mcp-servers                                    |
 +----------+----------------------------------+           |
 | woo-mcp     mcp-server-2     mcp-server-3   |<----------+
 |      internal only, no Ingress              |
 +---------------------------------------------+
```

## Components

| Component | Namespace | Responsibility | Public |
|---|---|---|---|
| wordpress | store | Storefront and WooCommerce admin | Yes, through Ingress |
| mariadb | store | Store database | No |
| woo-mcp | mcp-servers | MCP server written in this repo; exposes products and orders | No |
| mcp-server-2, mcp-server-3 | mcp-servers | Two further upstream MCP servers (not yet chosen) | No |
| gateway backend | gateway | Dashboard API, public MCP endpoint, MCP client to every upstream, chat agent | Yes, through Ingress |
| dashboard | gateway | React user interface | Yes, through Ingress |
| postgres | gateway | Users, hashed API keys, upstream server records, audit log | No |

## Decisions

### 1a. The gateway backend is a single service

The dashboard API, the public MCP endpoint and the chat agent are modules of one Node and TypeScript process.

- Why: all three need the same things (who the user is, which upstreams are enabled, the audit log). Splitting them would move the same logic across the network three times.
- Tradeoff: the parts cannot be scaled independently. That is not needed at this size.

### 1b. The chat agent calls tools through a shared internal interface

The agent is a module inside the backend. It can reach upstream tools only through the same internal interface that the public MCP endpoint uses, conceptually `listTools(user)` and `callTool(user, tool, args)`. Permission checks, routing, timeouts and audit logging live inside that interface.

- Why: there is exactly one code path to an upstream. Key revocation, disabled servers, timeouts and audit apply identically to chat and to external clients, and the agent cannot bypass them.
- Alternative rejected: the agent acting as a real MCP client against the gateway's own `/mcp` endpoint. Inside one process this adds a network hop and an internal token to protect, with no benefit. It becomes the right choice only if the agent is split into its own service, and the interface above is shaped so that split is possible later.

### 1c. Three namespaces and three Helm charts

Namespaces `store`, `mcp-servers` and `gateway`, each deployed by its own chart and release. Each namespace is created by `helm install --create-namespace`, so deployment stays Helm-only.

- Why: namespaces make the public and internal boundary explicit and give NetworkPolicy a clean target. Separate releases can be upgraded and rolled back independently.
- Tradeoff: three `helm install` commands instead of one.
- Alternative rejected: one namespace and one chart. Simpler, but a weaker isolation story.

### 2. PostgreSQL for gateway data

One PostgreSQL pod with a PersistentVolumeClaim.

- Why: the data is relational (users to keys, servers to tools, audit rows filtered and sorted). It also allows more than one gateway replica later.
- Alternatives rejected: MongoDB (relations and audit queries handled by hand); SQLite (limits the gateway to one replica).

### 3. Dashboard login is separate from API keys

- People sign in to the dashboard with email and password. The session is held in an httpOnly cookie. Passwords are hashed with a slow password hash (argon2 or bcrypt).
- The first admin is created at install time from a Kubernetes Secret.
- An admin adds a member by email. The system produces a one-time invite link that the admin passes on. No email is sent.
- API keys are for MCP clients only and are never used as a browser login.
- Why: a browser session and a machine credential have different lifetimes and different exposure. Keeping an API key in browser storage would weaken it.

### 4. API keys are random, shown once, stored as a SHA-256 hash

- Format: prefix `mcpgw_` followed by 32 random bytes, encoded.
- Only the SHA-256 hash is stored. The full key is shown once at creation.
- Revocation marks the key as revoked; the next request with it is rejected.
- Why SHA-256 and not bcrypt: the key is long and random, so it cannot be guessed and a slow hash adds no security. A fast hash keeps the per-request lookup cheap.

### 5. Every tool name is always prefixed with its server slug

- Exposed name: `<server-slug>__<tool>`, for example `woo__list_orders`.
- The slug is set by the admin when registering the server and is unique.
- Routing: split the exposed name on the first `__`, look up the server by slug, call the original tool name on that server.
- Why always, not only on collision: names stay stable when servers are added or removed, so clients never see a tool silently change its name.

### 6. woo-mcp talks to the store through the WooCommerce REST API

- The consumer key and secret live in a Kubernetes Secret.
- Calls go to the WordPress Service inside the cluster.
- Why: it is the official, documented and stable interface, and it lets the MCP server run as its own pod.
- Alternative rejected: WP-CLI. It needs command execution inside the WordPress pod, which would give the MCP server far more access than it needs.

### 7. Upstream MCP servers are internal only, enforced in two layers

1. No Ingress. Each upstream has a ClusterIP Service only, so nothing outside the cluster can reach it.
2. A NetworkPolicy in `mcp-servers` that allows ingress only from the `gateway` namespace, so other pods inside the cluster cannot reach it either.

- Why both: the first layer alone stops external traffic but still lets any pod in the cluster call the MCP servers. The requirement is that only the gateway can.
- k3s enforces NetworkPolicy without extra setup, locally (k3d) and on the VPS.

### 8. Local domain approach: hosts file entries

The two public hostnames are `store.urumi.test` and `gateway.urumi.test`. Locally, the Windows hosts file maps both to `127.0.0.1`, and k3d maps host ports 80 and 443 to the Traefik ingress controller. Production uses real DNS records for the store host and the gateway host; the hostnames are set only through Helm values (`values-local.yaml` and `values-prod.yaml`).

- Why: no extra software, and `.test` is reserved (RFC 6761), so it never collides with a real domain. URLs stay stable and Ingress routes by host, exactly as in production.
- Tradeoff: one manual administrator edit of the hosts file per developer machine, and the hosts file has no wildcards, so each new hostname needs its own line.
- Alternatives rejected:
  - `*.localhost` hostnames: no setup, but not resolved by Node and some CLI tools on Windows, so an external MCP client could fail to connect.
  - nip.io style DNS: needs internet DNS and a third-party service, and some home routers block DNS answers that point to 127.0.0.1.

## Store chart

Decisions 9 to 14 describe the Helm chart in `charts/store` (WordPress, WooCommerce and MariaDB in the namespace `store`). Each was checked on the local k3d cluster, and the evidence is noted where it matters.

### 9. WordPress and WooCommerce are installed by a Helm hook Job

A post-install and post-upgrade hook Job, `store-bootstrap`, runs the idempotent script `charts/store/files/bootstrap.sh` with the official WP-CLI image (`wordpress:cli-2.12.0-php8.3`). It installs WordPress core, installs and activates WooCommerce at a pinned version (`woocommerce.version` in the values, currently 11.2.0), sets currency, country, timezone, permalinks, cash on delivery and free shipping, and reads the result back. The script checks the current state before each step, so a repeat run changes nothing that is already correct.

- Verified: a fresh install of the whole chart takes about three minutes with no click in wp-admin. A second `helm upgrade` with unchanged values left the Secret, the admin password hash, the key options and the pods identical.
- Why: there is no custom image to build or distribute, so a fresh clone needs only `helm upgrade --install`. The same Job also reconciles the configuration on every upgrade.
- Tradeoff: the install needs internet access to download WooCommerce from wordpress.org. The Job shares the ReadWriteOnce content volume with WordPress, so it runs as uid 33 (the user of the WordPress image) and has a pod affinity to the WordPress pod. It has no probes: it is a run-to-completion workload bounded by `activeDeadlineSeconds`, `backoffLimit` and resource limits.
- Alternatives rejected:
  - A custom image with WP-CLI and the plugin baked in: it needs a build step and a way to reach both k3d and the VPS.
  - A sidecar: a container that stays running only to run a script once. An init container does not work either, because it would run before the image entrypoint has put WordPress on the volume.

### 10. Credentials are generated in the cluster and never appear in arguments or logs

The chart creates the Secret `store-credentials` (MariaDB root password, MariaDB application password, WordPress admin password). On first install each value is random (32 characters). On upgrade `lookup` reuses the stored value, and the Secret carries `helm.sh/resource-policy: keep`. The values files hold no credentials; optional overrides exist and are empty by default.

The admin password is applied once. WordPress is installed with a random throwaway password. Then a `wp eval` call reads the real password from a mounted file and sets it, and a second call checks it and prints only `password-ok` or `MISMATCH`. A marker option (`store_bootstrap_admin_password_set`) stops later runs from resetting a password that was changed in wp-admin. Only the `wordpress-admin-password` key is mounted into the Job (`items`). The MariaDB passwords reach the pods through `secretKeyRef` environment variables, and the root password reaches only the MariaDB pod.

- Verified: none of the three values was found in the Job, WordPress and MariaDB logs or in the pod, Job and ConfigMap specs, using a scan with a positive control. The Secret digest stayed the same across upgrades. Login works with the Secret password and fails with a wrong one.
- Why: nothing sensitive in Git or in values, and passwords stay stable across upgrades. The database volume was initialised with these passwords, so the Secret must survive an uninstall, or the chart would be locked out of its own data.
- Tradeoff: the Secret and both volumes survive `helm uninstall`, so a reinstall reuses old data; a full wipe means deleting the namespace. The rendered Secret is also stored (base64) in the Helm release metadata, readable by anyone who can read Secrets in the namespace. Under `helm template`, `lookup` returns nothing, so a rendered Secret is random.
- Alternatives rejected:
  - A Secret created beforehand and passed by name: the namespace must exist first, which conflicts with decision 1c.
  - `--set` at install time: it has to be repeated on every upgrade.
  - WP-CLI `--prompt=admin_password` with the password on stdin: it keeps the password out of the arguments, but it echoes the password and the command it rebuilt into the log. This was found during the first run.

### 11. MariaDB is a StatefulSet, WordPress is a Deployment with the Recreate strategy

MariaDB is a StatefulSet with one replica and a `volumeClaimTemplates` PVC that is kept when the StatefulSet is deleted or scaled down. It has a ClusterIP Service and a headless governing Service, and no Ingress. WordPress is a Deployment with one replica and `strategy: Recreate`, its own PVC (`wordpress-data`, kept on uninstall), a ClusterIP Service, and the only Ingress of the chart.

- Verified: `rollout restart` of both workloads kept the same PVCs and the same product and order. The MariaDB log shows that the existing data directory was reused.
- Why: the database needs a stable identity and volume. WordPress keeps its files on a ReadWriteOnce volume that two pods cannot share, so the old pod must stop before the new one starts.
- Tradeoff: an update means a short downtime, and WordPress cannot run more than one replica without moving its content to shared or object storage.
- Alternatives rejected:
  - A Deployment with Recreate for MariaDB: it works, but loses the stable identity and the retention policy of the StatefulSet.
  - RollingUpdate for WordPress: the new pod would need the volume while the old pod still holds it.

### 12. The public URL comes from values; the loopback host alias exists only locally

`WP_HOME` and `WP_SITEURL` are built from `store.scheme` and `store.host` and passed in `WORDPRESS_CONFIG_EXTRA`. The `wp-config.php` of the official image evaluates it at runtime, so the address follows the values and not a copy stored in the database. In `values-local.yaml`, `wordpress.loopbackHostAlias: true` adds a host alias in the WordPress pod that maps the public hostname to `127.0.0.1`.

- Verified: `wp-config.php` evaluates `WORDPRESS_CONFIG_EXTRA`. From inside the WordPress pod, a request to the public URL succeeds (a redirect to the install page, then 200, before the install).
- Why: pods cannot resolve a name that exists only in the developer's hosts file (decision 8), and WordPress calls its own public URL, for example for WP-Cron and loopback requests. Apache listens on port 80 in that pod, so the alias lets those calls succeed with no DNS or Ingress dependency.
- The bootstrap Job has no alias: nothing listens on port 80 there, and none of its WP-CLI commands calls the site URL.
- Tradeoff: in production the hostname must resolve from inside the cluster through real DNS. That is not tested yet, and a loopback over https is not handled.
- Alternatives rejected:
  - A custom CoreDNS entry: a cluster-wide change outside Helm.
  - Doing nothing: WordPress's requests to its own address would fail.

### 13. The WooCommerce onboarding profile is marked as skipped at install

If the option `woocommerce_onboarding_profile` does not exist, the bootstrap script writes `{"skipped": true}`, which is the state the wizard's Skip button writes. The script also sets `woocommerce_coming_soon` and `woocommerce_store_pages_only` to `no`, and `woocommerce_allow_tracking` to `no`.

- Why: without this, the first administrator who skips or finishes the Core Profiler hides the store. The profiler posts to `/wp-json/wc-admin/launch-your-store/initialize-coming-soon`, and `initialize_coming_soon()` in the plugin (`src/Admin/API/LaunchYourStore.php`) overwrites `woocommerce_coming_soon` with `yes`. The access log shows that call a few seconds after the Skip request. The wizard also switched usage tracking on.
- Verified on a fresh install: no redirect to the wizard on the WooCommerce admin pages, the options stayed `no`, and `woocommerce_private_link` (created only by that call) was absent. In the browser there was no wizard and the admin bar showed "Live". The share key is not a marker, because opening the WooCommerce settings page creates it too.
- Tradeoff: it relies on WooCommerce honouring `skipped`, verified for 11.2.0 only. An existing profile, for example one completed by hand, is never overwritten.
- Alternatives rejected:
  - Only setting coming soon to `no` on every run: the store stays hidden between the wizard and the next upgrade.
  - A must-use plugin or a filter: it is an extra file on the volume, and the `woocommerce_enable_setup_wizard` filter is only checked for the activation redirect.

### 14. Readiness may depend on the database; liveness must not

WordPress: the startup and readiness probes use `/wp-login.php` (it needs PHP and the database). The liveness probe uses `/wp-includes/images/blank.gif`, a static core file that Apache serves directly (the `.htaccess` rule skips `index.php` for existing files). MariaDB: the startup and readiness probes run `healthcheck.sh --connect --innodb_initialized`, and the liveness probe is a TCP check on port 3306.

- Measured with MariaDB scaled to 0 and liveness on `/wp-login.php`: WordPress went NotReady after about 31 seconds, and its container was restarted at about 46 seconds (restarts 0 to 1), with `Liveness probe failed: statuscode 500` three times and a kill event.
- Measured after the change, same test for 153 seconds: NotReady from about 31 seconds, restarts stayed 0, no liveness event, and 20 readiness failures. The storefront answered 503 while the Service had no ready endpoint. Straight to the pod, the static path returned 200 while `/wp-login.php` returned 500. After MariaDB came back, the pod was Ready again with no restart, and the product and order were intact.
- Why: a database outage should take the pod out of the Service, not restart a healthy Apache.
- Tradeoff: liveness now notices only that Apache or the core files are gone. PHP-level problems are caught by readiness, which removes the pod from the Service but does not restart it.
- Alternatives rejected: liveness on `/wp-login.php` (measured above). A TCP check on port 80 was the fallback and was not needed.
- The hook Job and the test Pod are run-to-completion workloads and have no probes (decision 9).

## Known limitations

- The startup probe still uses `/wp-login.php`. If MariaDB is down for more than five minutes (60 checks, 5 seconds apart) while the WordPress container is starting, the kubelet kills and restarts it. This follows from the probe configuration and was not tested.
- WP-CLI runs with the PHP default `memory_limit` of 128 MB. The Job's WooCommerce install fits, but unpacking WordPress core with `wp core download` ran out of memory in a test container, so a larger plugin could fail. The limit is not raised.
- `woocommerce_coming_soon` is set to `no` on every install and upgrade. A store that an administrator deliberately switched to private is made live again by the next `helm upgrade`.
- The scheme is `http` in both values files. The chart has no Ingress TLS section and TLS is undecided, so `https` must come together with TLS.
- `values-prod.yaml` is only rendered, not deployed. The domain and email are placeholders, and the volume sizes and resource numbers are untested starting points.
- Deviation from the brief: the brief asks for readiness and liveness checks on every workload. Every long-running workload (WordPress and MariaDB) has both, but the bootstrap Job and the `helm test` Pod are run-to-completion and have no probes. The Job is bounded by `activeDeadlineSeconds`, `backoffLimit` and resource limits, and the test Pod by `activeDeadlineSeconds`, `restartPolicy: Never` and resource limits.
- HPOS (custom order tables) is left at the WooCommerce default. The final value is `yes`. WooCommerce enables it for a new shop on the first full request after the install, not during the CLI activation, so the bootstrap read-back shows `no` and a later check shows `yes`. WP-CLI, WC-CLI and the REST API work with either storage, so the store checks do not depend on it.

## Credential domains

Two separate kinds of credential exist and they never mix.

| Credential | Travels between | Stored | Seen by |
|---|---|---|---|
| User API key | MCP client and gateway | SHA-256 hash in PostgreSQL | The user, once |
| Dashboard session | Browser and gateway | httpOnly cookie | Nobody; not readable by scripts |
| Upstream credential | Gateway and one upstream MCP server | Gateway side only | Admin when entering it; never returned afterwards |
| WooCommerce consumer key and secret | woo-mcp and WordPress | Kubernetes Secret | woo-mcp only |

The gateway never forwards a user's API key to an upstream, and never returns an upstream credential to a browser or an MCP client.

## Tool call flow

```text
client or chat agent
  -> gateway: identify the user (API key or session)
  -> gateway: resolve exposed tool name to server and original tool
  -> gateway: check the server is enabled
  -> gateway: call the upstream with the upstream credential and a timeout
  -> upstream MCP server: run the tool
  -> gateway: write the audit row (user, server, tool, timestamp, duration, outcome)
  -> client or chat agent: result or a clear error
```

Tool listing asks every enabled upstream in parallel, each with its own timeout. An upstream that fails or times out is marked unreachable and contributes no tools; the others are returned normally.

## Open decisions

| Decision | Decide before |
|---|---|
| Which two additional MCP servers to connect | Step 15 |
| LLM provider for the chat agent | Step 14 |

## Build order

1. Local k3d cluster
2. Store: WordPress, WooCommerce, MariaDB, persistence, Ingress
3. woo-mcp server
4. Gateway backend: data model, upstream registry, aggregation and routing
5. Authentication, API keys and roles
6. Audit logging
7. Dashboard
8. Chat agent
9. Two additional upstream servers
10. Failure handling, timeouts and collision tests
11. Security controls, including NetworkPolicy
12. End-to-end definition-of-done tests
13. Production-like deployment on k3s
14. README, system design note, threat model
15. Demo video and submission

No bonus or stand-out item starts before step 12 passes.