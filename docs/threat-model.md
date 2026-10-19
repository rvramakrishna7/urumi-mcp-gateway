# Threat model

This note reasons about what can go wrong in the system and what already stops it. It covers the local cluster and the single-node k3s VPS. Every claim points to a decision in `docs/architecture.md`, to `docs/network-policy.md`, or to a "VPS drill, 18 Oct 2026" (a check run on the VPS on that date; its output is not kept in the repository). A control that was only analysed and never tried is marked "not drilled".

## 1. Scope, assets, actors and boundaries

**Assets.**

| Asset | Where it lives |
|---|---|
| Store data (products, orders, customers) | MariaDB and the WordPress content volume in namespace `store` |
| Upstream credentials | Encrypted in PostgreSQL with AES-256-GCM (decision 30) |
| Master key of that encryption | Secret `gateway-master-key` |
| User API keys | SHA-256 hash in PostgreSQL, shown once (decision 4) |
| Dashboard sessions | Hash in PostgreSQL, httpOnly cookie (decision 35) |
| Groq API key | Secret `gateway-groq`, optional (decision 40) |
| Cloud metadata of the VPS | 169.254.169.254, reachable from the node network |

**Actors.** The internet; a member; an admin; a malicious or compromised upstream MCP server; a compromised pod inside the cluster; a manipulated model (text in a tool result or description that steers it).

**Trust boundaries.**
1. Internet to Traefik. Only two hosts are routed, and on the VPS only https (decision 8, `values-prod.yaml`).
2. Traefik to the gateway. The Ingress sends `/mcp`, `/healthz`, `/api/admin`, `/api/auth`, `/api/me`, `/api/audit` and `/api/chat` to the gateway and every other path to the dashboard, which serves static files (`charts/gateway/templates/gateway-ingress.yaml:32-41`; `/readyz` is not routed, decision 34).
   - Without a credential: `GET /healthz` (`src/app.ts:55`), `POST /api/auth/login` and `POST /api/auth/accept-invite` (`src/routes/auth.ts:50` and `:100`), and the static files of the dashboard. The two POST routes check the `Origin` (decision 35).
   - API key: `/mcp` (decision 32).
   - Session only: `/api/auth/logout`, `/api/auth/me`, `/api/me`, `/api/audit` and `/api/chat` (`src/routes/auth.ts:126` and `:137`, `me-keys.ts:44`, `audit.ts:65`, `chat.ts:56`).
   - Session or API key, and the admin role: `/api/admin` (`src/routes/admin.ts:65`).
3. Gateway to an upstream. The gateway adds the upstream credential and never forwards the user's key. A timeout and a size cap apply (decision 28).
4. Namespace `gateway` to `mcp-servers`. A default deny with one allow rule per path (`docs/network-policy.md`). Namespace `store` has no policy.
5. Model to tools. The model gets only the tools the user may use, and writes need a server-checked confirmation (decisions 40 and 43).

## 2. The four questions of the brief

### 2.1 Shared upstream credentials: what can a member do with a credential they never see?

**Threat.** All members use one set of credentials per upstream. The woo-mcp account is a WooCommerce `shop_manager`, so the credential can do more than the five tools expose.

**Controls.**
- The credential stays in the gateway: encrypted at rest, never returned by the API, never sent to a browser or an MCP client (decision 30, credential domains table at architecture.md:723).
- A member reaches the upstream only through the exposed tools. Members do not list or call the names in `security.memberRestrictedTools` (default `woo__create_product` and `woo__update_order_status`), checked before any credential is read (decision 43).
- woo-mcp, fx-mcp and fetch-mcp accept connections only from the gateway pod, so a member has no network path to an upstream (`docs/network-policy.md:31`, policy `allow-from-gateway`; decision 7).
- The woo-mcp tools return no customer email, phone, address or note, and the fields a customer controls are cleaned and shortened (README, woo-mcp section; decision 19).
- The woo-mcp account is `shop_manager`, not the administrator. It cannot manage options, install plugins or create users (architecture.md:230).
- Revocation is in one place: an admin disables the server or replaces its credential through the admin API, and every member is cut off at once (decision 28; README, gateway step 4).

**Residual risk.**
- The WooCommerce key is wider than the tools: it can edit customer accounts, which the five tools do not expose (architecture.md:230). A flaw in woo-mcp would expose that wider authority.
- The restriction is by exposed name. A server registered again under a new slug is not covered until its names are added (decision 43).
- Anyone who has both the database and the master key can read the credentials (decision 30).

**Evidence.** Decisions 30, 43 and 19; the local drill of decision 43 (a member refused and audited as `denied`).

### 2.2 Why a user's API key is never passed to an upstream

**Threat.** If the gateway forwarded the member's key, a malicious or compromised upstream could keep it and replay it against `/mcp` as that member. That is a confused-deputy problem: the upstream would hold a credential meant for a different audience.

**Controls.**
- Two separate credential domains. The user key goes only between the client and the gateway; the upstream credential goes only between the gateway and one upstream (credential domains table, architecture.md:723; decision 4).
- Each upstream receives only its own credential. A leaked upstream token is useful for that one server and is not a gateway identity.
- Revoking a user key is central: the next `/mcp` request fails, and every call is audited under the user (decisions 4, 32 and 38).
- The key check reads the database on every request, so there is no cached grant (decision 32).

**Residual risk.** Disabling a user does not revoke their keys; the keys stop only while the user is disabled (known limitation, architecture.md:657).

**Evidence.** VPS drill, 18 Oct 2026: after a key was revoked, the next `/mcp` request returned 401 `{"error":"unauthorized"}`. A 401 has no identity, so it is not written to the audit table.

### 2.3 Untrusted upstreams and tool descriptions that try to manipulate the model

**Threat.** An upstream, or an admin who registers a bad one, controls every tool name and description that the model sees, and the results of every call. Text can tell the model to call another tool or to send data out.

**Controls.**
- Names must match a strict pattern, descriptions are cleaned and capped, the input schema is capped at 32768 bytes, and at most 200 tools per server are stored (decision 29).
- Blast radius of a malicious upstream: each call carries only that server's own credential, so the server never receives a user's API key or another server's credential (decision 30; credential domains table, architecture.md:723; decision 28).
- Only an admin can register a server, and only at an address on the `host:port` allowlist. Every IP literal, `localhost`, the Kubernetes API and the gateway's own namespace are refused (decision 44).
- In the chat agent the model has exactly the logged-in user's authority, restricted tools are not offered to a member, and the system prompt is fixed on the server and says that tool output is data (architecture.md:558).
- Writes need a confirmation checked on the server: an HMAC token bound to the user, the tool and the arguments, valid for 5 minutes. Posting to the route directly does not skip it (architecture.md:556).
- Every fetch in chat needs a confirmation because a GET to a URL the model picks can send data out (decision 42, architecture.md:586).

**Residual risk.**
- The text inside an input schema (a property description, an enum value) and the results of tool calls are not cleaned. The gateway cannot stop instructions inside a result (architecture.md:671).
- Read-only tools can still be steered. A page that Fetch returns can push the model toward a woo write, which then needs its own card (architecture.md:587).
- A client on `/mcp` (Claude Code, Cursor) is not gated by the gateway; its own confirmation is the only one (architecture.md:587).
- The package behind fetch-mcp ships a tool description written to convince a model that it has internet access. This is a real, observed case (architecture.md:592).
- Tools substitute for each other. VPS drill, 18 Oct 2026: with fx-mcp unreachable, the model used `fetch__fetch` to call a public currency API instead. The fetch needed a card, but the substitution shows that a model picks another route when one fails.

**Evidence.** Decisions 29, 40, 42 and 44. VPS drill, 18 Oct 2026: registering `http://169.254.169.254/latest/meta-data/` as a server was refused and nothing was registered.

### 2.4 What one team member can do to another

**Threat.** Members share the system. One may try to read or revoke another's keys, read another's audit rows, take over a login, or starve the shared upstreams.

**Controls.**
- Key routes are scoped in SQL with `WHERE user_id = $caller`, and the user id comes from the session. An admin acts on another user's keys only through separate routes with the admin check (architecture.md:481 and :498).
- A key that is not yours returns 404, the same as a key that does not exist (architecture.md:498).
- Audit rows: a member sees only their own, decided in SQL, and sending `userId` is a 400 (decision 38, architecture.md:519).
- A session cannot be used on `/mcp`, and an API key cannot be used on the session-only routes. State-changing cookie requests need an exact `Origin` (decision 35).
- The admin API makes members only, and an admin's password is reset only with the CLI, so one admin cannot take over another (decision 36).

**Residual risk.**
- A member who knows another's email can lock that login for 15 minutes with five wrong passwords. The throttle is per email only, and the gateway sees no client address, so there is no per-IP lock (decisions 35 and 37). The throttle is not an exact bound under a burst: in a burst of 30 parallel logins (29 wrong passwords, the correct one last), 9 to 16 of the 29 wrong passwords were still answered 401 after the fix, not 5 (decision 35, measured; 12 rounds per the known limitation at architecture.md:657).
- `/mcp`, the admin API and failed API-key attempts have no rate limit, so one member can use up a shared upstream (known limitation, architecture.md:657). Only the chat agent has a per-user limit (decision 40).
- Members see the same store data by design. The audit log shows who ran a tool, not what was asked or returned.
- An admin can issue an invite to a member and accept it, which sets that member's password and lets the admin act as them. The audit log then shows the member's name (known limitation, architecture.md:657).

**Evidence.** Decisions 35 to 38 and 40; `GET /api/audit` and `/api/me/keys` tests described in decisions 36 and 38.

## 3. Other threats

| Threat | Control | Residual | Evidence |
|---|---|---|---|
| SSRF and cloud metadata | Allowlist of `host:port` (decision 44); NetworkPolicy on the gateway and MCP pods; IMDSv2 required, hop limit 1, no IAM role | The allowlist is checked at registration, not at connect time; no DNS pinning (decision 44) | VPS drill, 18 Oct 2026: gateway, woo-mcp, fx-mcp and fetch-mcp pods got ECONNREFUSED at once to the metadata address; the WordPress pod (no policy) got HTTP 401 on an IMDSv1 GET and a timeout on the IMDSv2 token PUT |
| Store namespace gaps | None beyond the Ingress; the storefront is public by design | No NetworkPolicy; WordPress and MariaDB set no security context; WordPress, MariaDB and the bootstrap Job mount the default ServiceAccount token. A pod inside the cluster could reach WordPress directly and send its own `X-Forwarded-Proto` (`docs/network-policy.md:92`) | README, "Stand-out items attempted"; `docs/network-policy.md` |
| CSRF and sessions | `SameSite=Strict`, exact `Origin` check, httpOnly cookie, 12 hour limit and 2 hours idle, hash stored (decision 35) | The cookie is `Secure` only when the public origin is https (decision 35), so it is not `Secure` on the local http cluster | Decision 35 |
| Database superuser | The database is reachable from the gateway pod only (`docs/network-policy.md`) | The application user is a PostgreSQL superuser; it runs migrations and normal queries (architecture.md:700) | The `gateway-checks` log on the VPS prints `the application user is a superuser: true` |
| Data at rest | k3s secrets encryption is on (AES-CBC, hashes match, no key rotation yet) | The EBS root volume is not encrypted, so PostgreSQL and MariaDB data on disk are not encrypted by k3s | `k3s secrets-encrypt status` on the VPS, 20 Oct 2026 |
| SSH exposure | Port 22 open from one home IP only; ports 6443 and 10250 closed | The address changes with the home network and then needs a security group edit | README, "Production-like setup (VPS)" |
| Admin actions leave no audit row | Admin actions on users and keys are written to the pod log with ids only | The log is lost with the pod, and the admin API has no audit table of its own (architecture.md:657) | Known limitations |
| Groq key | A Secret created by hand, mounted as a file, never logged or returned (architecture.md:554) | Egress allows any public IP on port 443, so a compromised gateway could send the key anywhere (`docs/network-policy.md:90`) | Decision 40; network-policy.md |
| Cluster DNS and pod labels | `allow-dns` limited to kube-dns | DNS can carry data out; the policies trust pod labels, so who may create pods in the `gateway` namespace is part of the boundary (`docs/network-policy.md:93-94`, not drilled) | network-policy.md |

## 4. Residual risks in priority order

| # | Risk | Next fix |
|---|---|---|
| 1 | No rate limit on `/mcp`, the admin API and failed key attempts: a guessed or leaked key, or one busy member, can flood the gateway and the shared upstreams | Add a per-key limit on `/mcp` and a limit on failed authentication, built like the chat limit (decision 40) |
| 2 | The `store` namespace has no NetworkPolicy and the store pods run without a security context and with the default ServiceAccount token | A default-deny policy for `store` with allow rules for Traefik and woo-mcp; `runAsNonRoot` and `automountServiceAccountToken: false` where the images allow it |
| 3 | Data at rest: an unencrypted EBS volume holds the databases and, with the k3s state, the keys to read them | Encrypt the EBS volume; rotate the k3s encryption key; move the master key out of a plain Secret |
| 4 | Untrusted results can steer the model, and a `/mcp` client has no gate | Keep the chat confirmations; add a warning in the README for external clients; consider a gateway-side confirmation list for `/mcp` |
| 5 | The application database user is a superuser | A separate migration owner and a limited runtime role (architecture.md:700) |
| 6 | Disabling a user leaves their keys valid, and admin actions are only in the pod log | Revoke the keys when a user is disabled; write admin actions to an audit table |

Two items are not ranked here because they need a decision: the login throttle bound (decision 35 proposes an atomic reservation) and the check of the SSRF allowlist at connect time (decision 44).
