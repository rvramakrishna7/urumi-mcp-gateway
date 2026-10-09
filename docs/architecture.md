# Architecture

This document records the approved architecture decisions for the team MCP gateway. It is the source of truth for design. If a decision is not written here, it has not been made.

Status: decisions 1 to 8 approved. Two decisions are still open and are listed at the end.

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