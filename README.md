# Team MCP Gateway on Kubernetes

WooCommerce store with a team MCP gateway, deployed on Kubernetes with Helm.

The local cluster, the store, the three upstream MCP servers (woo-mcp, fx-mcp and fetch-mcp), the gateway with its dashboard and chat agent, and the network isolation are documented. The rest is added as it is built and verified. Follow the sections in the order they appear: each chart is installed only after the images it deploys are built and imported into the cluster.

## Local setup

This section covers the cluster and the store (WordPress, WooCommerce and MariaDB). The whole setup was tested on Windows 11 with WSL2, Docker Desktop (about 8 GB of memory) and Git Bash. Run the commands from the repository root.

### Prerequisites

| Tool | Version used |
|---|---|
| Docker Desktop (engine version) | 29.8.2 |
| k3d | v5.9.0 (k3s v1.35.5) |
| kubectl | v1.36.1 |
| Helm | v4.3.0 |
| Git | 2.52.0 |

Ports 80 and 443 must be free on the host. The cluster downloads images and the WooCommerce plugin, so it needs internet access.

### 1. Create the cluster

```bash
k3d cluster create --config cluster/k3d-config.yaml
kubectl get nodes
```

The node should be `Ready`. The cluster keeps the default Traefik ingress controller and the `local-path` storage class, and maps host ports 80 and 443 to Traefik.

### 2. Map the store hostname

Add this line to `C:\Windows\System32\drivers\etc\hosts`. Open the file in Notepad started with "Run as administrator":

```text
127.0.0.1 store.urumi.test gateway.urumi.test
```

Check it with `ping -n 1 store.urumi.test`; the reply should come from 127.0.0.1. The reasoning is in `docs/architecture.md`, decision 8.

### 3. Install the store

```bash
helm upgrade --install store charts/store \
  --namespace store --create-namespace \
  -f charts/store/values-local.yaml \
  --wait --timeout 10m
```

The first install takes about three minutes. A Helm hook Job named `store-bootstrap` installs WordPress and WooCommerce 11.2.0 with the official WP-CLI image and configures the store: currency INR, country India (Maharashtra), timezone Asia/Kolkata, pretty permalinks, cash on delivery enabled, free shipping, and the store set live. Follow it with:

```bash
kubectl logs -n store job/store-bootstrap
```

Running the same command again is safe: the Job only changes what differs. The storefront is at `http://store.urumi.test/` and the admin at `http://store.urumi.test/wp-admin/` (user `storeadmin`).

### 4. Get the admin password

The password is generated inside the cluster on first install and kept in the Kubernetes Secret `store-credentials`. It is never written to Git or to logs. Copy it to the clipboard in your own terminal, so it is never printed:

```bash
kubectl get secret store-credentials -n store -o jsonpath='{.data.wordpress-admin-password}' | base64 -d | clip
```

Paste it into the password manager or the login form, then clear the clipboard with `printf '' | clip`. On Linux use `xclip -selection clipboard` instead of `clip`, on macOS `pbcopy`.

### 5. Place a test order with cash on delivery

1. Open `http://store.urumi.test/wp-admin/`, sign in as `storeadmin`, go to Products, Add New Product, enter a name and a price, and publish it.
2. In a private browser window, open `http://store.urumi.test/shop/`. The product should be listed.
3. Open the product, add it to the cart, and go to the checkout. Enter any customer details, choose Free shipping and Cash on delivery, and place the order. The "Order received" page shows the order number.
4. In wp-admin, open WooCommerce, Orders. The order is listed with the status Processing.

### 6. Run the checks

```bash
helm test store --namespace store
kubectl logs -n store pod/store-checks
```

The test Pod is read-only. It lists the products and orders with WP-CLI and WC-CLI (without customer details), counts the orders created today, and checks that the storefront is live and shows every published product.

It also checks the service account that the MCP server will use. The bootstrap Job creates the WordPress user `woo-mcp` (role Shop manager) and a Read/Write WooCommerce REST API key for it, generated in the cluster and kept in the Secret `woo-mcp-api` (`docs/architecture.md`, decision 15). The checks print only names, counts and yes or no answers, never the key or the secret:

- exactly one `woo-mcp` user, with the role `shop_manager`
- the capabilities the tools need are present, and the capabilities for managing plugins, options and users, or editing the administrator, are absent
- exactly one API key with the managed description, owned by `woo-mcp`, with the permission `read_write`
- the stored key and secret match the Secret

## WooCommerce MCP server (woo-mcp)

woo-mcp is the MCP server of this repository that exposes the store as tools over Streamable HTTP. It runs inside the cluster, has no Ingress, and is called with a bearer token. Install the store first (the sections above), because woo-mcp copies its WooCommerce key from the store. The design is in `docs/architecture.md`, decisions 16 to 23.

The five tools are `list_products`, `create_product`, `list_orders`, `get_order` and `update_order_status`. `list_orders` takes `date_from` and `date_to` as `today`, `yesterday` or `YYYY-MM-DD`, in the store timezone. No tool returns a customer's email, phone, address or note. `create_product` accepts plain text only: a name, description or sku that contains `<` or `>` is rejected. Text that comes from customers is cleaned and shortened in the order output, but it is still data written by someone else and must never be treated as an instruction (`docs/architecture.md`, decision 19).

### 1. Run the unit tests

```bash
cd services/woo-mcp
npm ci
npm run typecheck
npm test
cd ../..
```

The tests need no cluster. They use local HTTP servers and a stand-in for WooCommerce.

### 2. Build the images and import them into the cluster

The `mcp-servers` chart of step 3 deploys three servers (woo-mcp, fx-mcp and fetch-mcp), so build and import all three images first:

```bash
docker build -t woo-mcp:0.1.1 services/woo-mcp
k3d image import woo-mcp:0.1.1 -c urumi

docker build -t fx-mcp:0.1.0 services/fx-mcp
k3d image import fx-mcp:0.1.0 -c urumi

docker build -t fetch-mcp:0.1.0 services/fetch-mcp
k3d image import fetch-mcp:0.1.0 -c urumi
```

The woo-mcp image is based on `node:24.21.0-alpine3.24`, contains only the compiled code and the production dependencies, and runs as user 10001. The chart uses `imagePullPolicy: IfNotPresent`, so the imported images are used and nothing is pulled. fx-mcp and fetch-mcp are described in the section "Additional upstream servers" below.

### 3. Install the mcp-servers chart

```bash
helm upgrade --install mcp-servers charts/mcp-servers \
  --namespace mcp-servers --create-namespace \
  -f charts/mcp-servers/values-local.yaml \
  --wait --timeout 3m
```

The chart reads `consumer-key` and `consumer-secret` from the Secret `woo-mcp-api` in the namespace `store`, copies only those two into its own Secret, and generates a bearer token in the Secret `woo-mcp-auth`. If the store Secret does not exist, the install stops with a message that says so. Then check it:

```bash
kubectl get pods,svc,ingress -n mcp-servers
helm test mcp-servers -n mcp-servers
kubectl logs -n mcp-servers pod/woo-mcp-checks
```

The woo-mcp pod should be `1/1 Running` with 0 restarts, the Service should be `ClusterIP`, and there should be no Ingress. The test pod prints PASS lines (names and counts only, never a secret): the mounted files exist, `/healthz` and `/readyz` answer, `/mcp` refuses a missing or wrong token, `tools/list` returns 5 tools, and `list_products` reaches WooCommerce.

### 4. Call the tools through a port-forward

woo-mcp is not reachable from outside the cluster, so open a port-forward in one terminal:

```bash
kubectl port-forward svc/woo-mcp 18091:8080 -n mcp-servers
```

In a second terminal, read the token into a shell variable (it is not printed) and list the tools:

```bash
TOKEN=$(kubectl get secret woo-mcp-auth -n mcp-servers -o jsonpath='{.data.token}' | base64 -d)

curl -s -X POST http://127.0.0.1:18091/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without the `Authorization` header the same request returns 401. The answer is a server-sent event; the JSON-RPC message is on the line that starts with `data:`. To call a tool, send `tools/call`. This lists the orders of yesterday in the store timezone:

```bash
curl -s -X POST http://127.0.0.1:18091/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_orders","arguments":{"date_from":"yesterday"}}}'
```

A failure that is expected, such as an invalid argument or the store being down, comes back as a result with `"isError":true` and a plain sentence, not as a protocol error.

### 5. Keys and tokens

The WooCommerce key comes from the store. After a rotation there (the commands are in decision 15 of `docs/architecture.md`), run the `helm upgrade` of step 3 again: the pod restarts with the new key. The bearer token is generated once and kept across upgrades. To rotate it, delete the Secret `woo-mcp-auth`, run the `helm upgrade` of step 3, and then run `kubectl rollout restart deployment/woo-mcp -n mcp-servers`. This token procedure was not run during testing; the key rotation was.

## Gateway (gateway)

The gateway keeps the list of upstream MCP servers, offers one public MCP endpoint (`/mcp`) to clients with a user API key, and writes an audit row for every tool call. Install the store and mcp-servers charts first (the sections above): the gateway chart copies the tokens of woo-mcp, fx-mcp and fetch-mcp from the Secrets `woo-mcp-auth`, `fx-mcp-auth` and `fetch-mcp-auth` (all three are created by the `mcp-servers` chart) and registers the three servers at install, and the install stops with a message if one of those Secrets is missing. The hosts file entry for `gateway.urumi.test` is the one from step 2 of the local setup. Run the commands from the repository root. The tests of the gateway are in `services/gateway`: `npm test` needs no Docker, and `npm run test:db` starts a throwaway PostgreSQL in Docker and runs everything.

### 1. Build the image and install the chart

```bash
docker build -t gateway:0.11.1 services/gateway
k3d image import gateway:0.11.1 -c urumi

docker build -t dashboard:0.7.0 services/dashboard
k3d image import dashboard:0.7.0 -c urumi

helm upgrade --install gateway charts/gateway \
  --namespace gateway --create-namespace \
  -f charts/gateway/values-local.yaml \
  --wait --timeout 5m
helm test gateway -n gateway
kubectl logs -n gateway pod/gateway-checks
```

The release has PostgreSQL (a StatefulSet with a persistent volume), the gateway Deployment and the dashboard Deployment (the static files, served by nginx). A `migrate` initContainer creates the schema before the server starts. The test pod prints PASS lines (names and counts only): the database, the migrations, the tables, the seeded server `woo` with an encrypted credential, and the public routes. The Ingress routes only `/mcp`, `/healthz`, `/api/admin`, `/api/auth`, `/api/me`, `/api/audit` and `/api/chat`: `curl -i http://gateway.urumi.test/readyz` answers 404 on purpose. The values file `values-local.yaml` sets `bootstrap.adminEmail`, so the install also makes the Secret `gateway-bootstrap` (one random invite token) and the gateway creates that admin at start, without a password.

**Tool permissions.** Members cannot list or call the tools in `security.memberRestrictedTools` of `charts/gateway/values.yaml` (default `woo__create_product` and `woo__update_order_status`); admins can. `fetch__fetch` is open to members but stays in `chat.confirmTools` (every chat fetch needs a click), and the egress of fetch-mcp is limited by NetworkPolicy. Change the list in a values file and run the `helm upgrade` above. It must not be empty. Rendering the chart without a cluster (`helm template`, `helm lint`) needs `--set seed.requireExisting=false`, because the chart looks up the upstream Secrets with `lookup`.

**Upstream address allowlist.** An admin can register an upstream server only at an address in `security.upstreamAllowedHosts` of `charts/gateway/values.yaml` (default: `woo-mcp`, `fx-mcp` and `fetch-mcp` on `mcp-servers.svc.cluster.local:8080`). Each entry is exactly `host:port`: no wildcards, no IP addresses, and the list must not be empty. Any other address, an IP address, `localhost`, the Kubernetes API, or a name inside the gateway's own namespace is refused with `400` (`url_blocked` and a reason code), on create, on edit and in the install seed. To add a new upstream, add its `host:port` to `security.upstreamAllowedHosts` in your values file and run the `helm upgrade` above, then register it in the dashboard. The check runs when a server is registered, not on every connection (see the known limitations in `docs/architecture.md`, decision 44).

### 2. Set the password of the first admin, then create users and keys

The first admin is made by the install (`bootstrap.adminEmail`, `admin@urumi.test` locally). It has no password: you choose it with the invite token that the chart keeps in the Secret `gateway-bootstrap`. The password is never generated, stored in plain text or logged. This block works in Git Bash, Linux and macOS (it builds the JSON with `printf` and `sed`, so it needs no `node` and no `jq`; in Git Bash `node` is an alias that refuses to run in a pipe). The password is typed without echo and goes to curl through a pipe, never into the command line:

```bash
umask 077
kubectl get secret gateway-bootstrap -n gateway -o jsonpath='{.data.inviteToken}' | base64 --decode > bootstrap.token

printf 'Choose a password (12 to 128 characters, not shown): '
IFS= read -rs PW; printf '\n'
printf '{"token":"%s","password":"%s"}' "$(cat bootstrap.token)" "$(printf '%s' "$PW" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" |
  curl -s -w '\nHTTP %{http_code}\n' -X POST http://gateway.urumi.test/api/auth/accept-invite \
    -H 'Origin: http://gateway.urumi.test' -H 'Content-Type: application/json' --data-binary @-
unset PW; rm -f bootstrap.token
```

`HTTP 200` means the password is set and the admin is signed in; the token cannot be used again. Any other answer is 400 (the token is wrong, used or expired, or the password is too weak) or 403 (the `Origin` header). If the 7 day token expired, restart the gateway (`kubectl rollout restart deployment/gateway -n gateway`): the start arms the token again while the admin has no password.

**Members.** An admin makes a member through the admin API (section 5) and gives them the one-time invite link, or the CLI does it from inside the pod. The invite is valid for 72 hours and can be used once; the member sets their own password with it. There is no route to change one's own password: an admin issues a new invite to a member (the reset), and the password of an **admin** is reset with the CLI only (`user invite`), so one admin cannot take over the account of another.

```bash
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js user invite --email admin@urumi.test > invite.token   # prints the token once
```

The new owner of the account sets the password with the accept-invite command above, with `invite.token` in place of `bootstrap.token`; delete `invite.token` afterwards.

**API keys in the dashboard.** Any signed-in user, admin or member, manages their own keys at `http://gateway.urumi.test/keys` (the "API keys" link on the home page): create a key with a name, copy it from the one-time reveal (it is shown once and cannot be shown again; only its first characters are listed afterwards), and revoke it. A user can have 10 active keys; revoked keys stay in the list, marked as revoked. An MCP client uses a key at `/mcp` with the header `Authorization: Bearer <key>`. Over plain `http` (the local cluster) the "Copy key" button cannot reach the clipboard, so the screen asks you to select the key and press Ctrl+C (known limitation, fixed by TLS in Step 20).

**API keys.** A signed-in user makes and revokes their own keys through `/api/me/keys` (session only, for the dashboard). For the commands in the sections below you need two key files, `admin.key` and `member.key`. The command-line tool makes a key for a user who is active; the new key is the only thing on stdout, so redirect it to a file (it is not printed) and keep the file private. The admin is active after the step above. The member is made first, with the CLI (active at once, no password; for a real member use the invite of section 5 instead):

```bash
umask 077
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js key create --email admin@urumi.test --name admin-laptop > admin.key

kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js user create --email member@urumi.test --role member
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js key create --email member@urumi.test --name laptop > member.key
```

The key starts with `mcpgw_`. The gateway stores only its SHA-256 hash, so it cannot be shown again; make a new one if it is lost. Other commands: `user list`, `user create --email <email> --role admin|member` (active at once, no password; for a script or a test), `key list --email <email>` and `key revoke --id <key id>` (a revoked key gets 401 on the very next request). `--help` prints the usage. Do not commit key or token files.

### 3. Connect an MCP client

The URL is `http://gateway.urumi.test/mcp` and the key goes in the header `Authorization: Bearer <key>`.

Claude Code, with a configuration file that is used only for this call:

```bash
printf '{"mcpServers":{"urumi":{"type":"http","url":"http://gateway.urumi.test/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$(cat member.key)" > mcp.json
claude -p "Call woo__list_products and answer with the product names only." \
  --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__urumi__woo__list_products"
rm mcp.json
```

MCP Inspector in CLI mode (it asks again on every call):

```bash
npx -y @modelcontextprotocol/inspector@2.10.1 --cli http://gateway.urumi.test/mcp \
  --transport http --header "Authorization: Bearer $(cat member.key)" --method tools/list
```

Both were run against this cluster: the member saw the five tools `woo__create_product`, `woo__get_order`, `woo__list_orders`, `woo__list_products` and `woo__update_order_status`, and Claude Code answered with the product names of the store. The tool names are `<server slug>__<tool>`, so two servers with a tool of the same name stay apart. A client reads the tool list once when it connects, so after a server is disabled it must reconnect to see the change; a call from an old list is refused with `Unknown tool`.

### 4. Register, disable and remove an upstream server

The admin API needs the key of an admin (a member gets 403). It never returns a credential, only `credential: {set: true, ...}`.

```bash
ADMIN="Authorization: Bearer $(cat admin.key)"
API=http://gateway.urumi.test/api/admin/servers

curl -s $API -H "$ADMIN"                                   # list, with the status of each server

curl -s -X POST $API -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"slug":"demo","name":"Demo server","url":"http://demo.demo-ns.svc.cluster.local:8080/mcp","credential":{"kind":"bearer","value":"<the upstream token>"}}'

curl -s -X PATCH $API/<id> -H "$ADMIN" -H 'content-type: application/json' -d '{"enabled":false}'   # disable
curl -s -X PATCH $API/<id> -H "$ADMIN" -H 'content-type: application/json' -d '{"enabled":true}'    # enable again
curl -s -X DELETE $API/<id> -H "$ADMIN"                    # remove (204)
```

`<id>` is the `id` in the list. A slug is lowercase letters, digits and `-`, at most 20 characters, and starts with a letter. A create or an update refreshes the tool list and the status at once, without waiting for the 15 second poll, so the next `tools/list` already shows the change. A server that cannot be reached is `unreachable` with a short reason (`refused`, `timeout`, `http_401`, `credential_unreadable`) and contributes no tools; the other servers are not affected. The upstream credential stays inside the gateway: it is encrypted in the database and is never sent to a client.

### 5. Manage users and their keys (admin)

These routes are under `/api/admin/users`. They need an admin: an API key (`Authorization: Bearer ...`) or the dashboard session (cookie plus an `Origin` header equal to the gateway origin for POST, PATCH and DELETE). A member gets 403.

| Route | What it does |
|---|---|
| `GET /api/admin/users` | List: id, email, role, status, createdAt, lastLoginAt, disabledAt. No hash or secret is returned. |
| `POST /api/admin/users` `{"email": ...}` | Make a **member** (a body with a `role` is 400) with status `invited`. The answer holds a one-time `invite` (`token`, `link`, `expiresAt`, 72 hours) that is shown once. |
| `POST /api/admin/users/:id/invite` | A new invite for a member (the password reset). **409 for an admin**: the password of an admin is reset with the CLI `user invite` only. 409 for a disabled user. |
| `PATCH /api/admin/users/:id` `{"status": "disabled"\|"active"}` | Disable or enable. You cannot disable yourself (409) and the last active admin cannot be disabled (409). |
| `GET /api/admin/users/:id/keys` | The keys of that user (prefix, name, dates, status; never the key). |
| `DELETE /api/admin/users/:id/keys/:keyId` | Revoke a key. 404 if the key does not belong to that user; the next `/mcp` request with it is 401. |

Disabling a user deletes their sessions and cancels a pending invite, and their API keys stop working at once because the user is not active. The keys are **not revoked**: if the user is enabled again, the same keys work again, so revoke a key explicitly if it must never come back. Enabling gives back `active` only when the user has a password; a user who never accepted an invite goes back to `invited` and needs a new invite.

```bash
ADMIN="Authorization: Bearer $(cat admin.key)"
API=http://gateway.urumi.test/api/admin/users

curl -s $API -H "$ADMIN"                                                       # list
curl -s -X POST $API -H "$ADMIN" -H 'content-type: application/json' -d '{"email":"new.member@example.com"}'   # invite link, once
curl -s -X PATCH $API/<id> -H "$ADMIN" -H 'content-type: application/json' -d '{"status":"disabled"}'
curl -s $API/<id>/keys -H "$ADMIN"
curl -s -X DELETE $API/<id>/keys/<keyId> -H "$ADMIN" -w '%{http_code}\n'      # 204
```

The admin actions (invite, disable, revoke) are written to the gateway log (ids only, never a token), not to the audit table, which holds tool calls.

**Members in the dashboard.** An admin manages the team at `http://gateway.urumi.test/users` (the "Members" link on the home page; a member is sent back to the home page). Invite a person by email: they join as a **member** (the admin API makes members only, so there is no role field and no role change). The invite link is shown once, in a panel inside the page, and works once for 72 hours; whoever opens it sets the password. "New invite" on a member row issues a fresh link and doubles as a password reset; admins and disabled users have no such button (an admin's password is reset with the command-line tool). "Disable" signs the person out at once and stops their keys until they are enabled again. Your own row and the last active admin cannot be disabled (the screen blocks both, and the gateway answers 409 as well). "Keys" on a row lists that person's keys and lets an admin revoke one; an admin cannot create a key for someone else.

### 6. Read the audit log

Every tool call has a row, written before the call and finished after it, whether it came from an external client (`via` is `mcp`) or the chat agent (`via` is `chat`). The dashboard reads the rows through `GET /api/audit`. The route takes the **session cookie only** (an API key is 401), and the scope is applied in the SQL: an **admin** sees every row, a **member** sees only their own rows, and a member who sends `userId` gets 400. Arguments and results are never stored, so they cannot be returned.

| Parameter | Meaning |
|---|---|
| `limit` | 1 to 200, default 50 |
| `cursor` | the `nextCursor` of the previous page (rows with a smaller id; keyset, not offset) |
| `userId` | admin only |
| `server`, `tool` | exact match (`server` is the slug) |
| `outcome` | `started`, `ok`, `error`, `timeout`, `unreachable`, `unknown_tool`, `denied` or `interrupted`; repeat the parameter for several |
| `via` | `mcp` or `chat` |
| `from`, `to` | ISO timestamps with a zone (`2026-10-11T00:00:00Z`); `from` is included, `to` is not; at most 90 days apart |

Any other parameter or a bad value is 400 (the answer names the field, never the value). The answer is `{ "items": [...], "nextCursor": "123" | null }`, newest first. A row that stays `started` is a call that has not ended (or one that was cut off: the sweeper that marks it `interrupted` is not built). Example, with the session cookie of a signed-in user in `cookies.txt` (log in with `-c cookies.txt` added to the login request):

```bash
curl -s -b cookies.txt 'http://gateway.urumi.test/api/audit?limit=5&outcome=ok&outcome=error'
```

You can still read the table directly:

```bash
kubectl exec -n gateway postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT ts, user_email, via, server_slug, tool, outcome, error_kind, duration_ms FROM audit_log ORDER BY id DESC LIMIT 10"'
```

### 7. Chat agent

The dashboard has a chat screen at `http://gateway.urumi.test/chat` (the "Chat" link, first on the home page; any signed-in user, admin or member). The agent is a module of the gateway process. It acts as the signed-in user, calls tools only through the gateway core (the same path as `/mcp`: routing, the disabled-server check, timeouts and the audit), and its calls are audited with `via` = `chat` under that user. The conversation is kept in the browser page only and is lost on reload; the gateway stores no prompts and no answers.

The model is Groq (`chat.model`, default `openai/gpt-oss-120b`). The key is **not** a chart value. Create the Secret `gateway-groq` by hand; the command reads the key without echoing it, keeps it out of the shell history and out of the process arguments:

```bash
read -rsp "Groq API key: " GROQ_KEY; echo
printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: gateway-groq\n  namespace: gateway\ntype: Opaque\ndata:\n  key: %s\n' "$(printf %s "$GROQ_KEY" | base64 -w0)" | kubectl create -f -
unset GROQ_KEY
kubectl rollout restart deploy/gateway -n gateway
```

The Secret is optional in the chart: without it the gateway starts normally and `POST /api/chat` answers 503 (the screen says the assistant is not set up). The key is read once at start, so a new key needs the restart above. To rotate it, delete the Secret, create it again and restart.

Writes need a confirmation. The tools in `chat.confirmTools` (default `woo__create_product`, `woo__update_order_status` and `fetch__fetch`) never run on the model's request alone: the screen shows a card with the tool and its arguments, and the change runs only after **Run**. The server checks a signed, 5-minute token bound to the user, the tool and the arguments, so posting to the route directly does not skip the card. **Cancel** sends nothing. If a Run fails in a way that may have run the change (a lost connection, a 500), the card is removed and the screen says to check the audit log before repeating it.

A user can send `chat.ratePerMinute` requests per minute (default 10; over it the gateway answers 429 and the screen shows a countdown). Groq has its own limits: rapid successive turns can end in "The model service is busy" (see the known limitations in `docs/architecture.md`).

## Additional upstream servers (fx-mcp, fetch-mcp)

The gateway has two more upstream servers, both deployed by the `mcp-servers` chart next to woo-mcp and, like it, reachable only inside the cluster with a bearer token. Both are documented in detail in `docs/architecture.md`, decisions 41 and 42.

### 1. fx-mcp (currency rates)

fx-mcp is an own-built MCP server (`services/fx-mcp`, the same skeleton as woo-mcp) that reads the public Frankfurter API. It needs egress to `api.frankfurter.dev`. It has three read-only tools: `list_currencies`, `get_rate` and `convert_amounts`. The last one converts a list of amounts and returns the sum, so the model does not do the arithmetic itself.

```bash
cd services/fx-mcp
npm ci
npm run typecheck
npm test
cd ../..
```

The tests need no cluster and no internet: they use a fake Frankfurter server. The image `fx-mcp:0.1.0` was built and imported in woo-mcp step 2, and the `helm upgrade` of woo-mcp step 3 already created the Deployment, the Service and the Secret `fx-mcp-auth`. The gateway seeds the server automatically under the slug `fx` (tools `fx__list_currencies`, `fx__get_rate`, `fx__convert_amounts`) with its token copied from that Secret, at the `helm upgrade` of the gateway step 1. Nothing more needs to be installed for it.

### 2. fetch-mcp (fetch a URL)

fetch-mcp is the reference `mcp-server-fetch` (pinned to an exact version in `services/fetch-mcp/requirements.txt`) behind `supergateway`, which serves it as Streamable HTTP. It has one tool, `fetch`, and no server code of ours.

The image `fetch-mcp:0.1.0` was built and imported in woo-mcp step 2, and the `helm upgrade` of woo-mcp step 3 already created the Deployment, the Service and the Secret `fetch-mcp-auth`, as for fx-mcp. The gateway seeds the server under the slug `fetch` at the `helm upgrade` of the gateway step 1, so the tool is `fetch__fetch`. In the chat agent `fetch__fetch` is in `chat.confirmTools`: every fetch shows a confirmation card with the exact URL, and it runs only after **Run**. This is on purpose, because a fetch is also a way to send data out.

There are no unit tests of our own. The check is at image level: `services/fetch-mcp/test/ssrf-drill.mjs` calls `fetch` with loopback, private and metadata addresses, other encodings of them and redirects to them, and expects every one to be refused; it also fetches public URLs, so a drill that refuses everything is not mistaken for a pass. It needs a canary web server on a private address (port 8000, `/canary.txt` holding the marker `INTERNAL-CANARY-9f3a`) that the pod can reach. Open a port-forward in one terminal:

```bash
kubectl port-forward svc/fetch-mcp 18092:8080 -n mcp-servers
```

In a second terminal, write the token to a file (it is not printed) and run the drill:

```bash
kubectl get secret fetch-mcp-auth -n mcp-servers -o jsonpath='{.data.token}' | base64 -d > fetch-token.txt
node services/fetch-mcp/test/ssrf-drill.mjs http://127.0.0.1:18092 fetch-token.txt <canary-host> <canary-ip>
rm fetch-token.txt
```

The drill prints one line per target (names and verdicts, never the token or a fetched body). The script header explains the `--expect-open` flag, which is for a container started with `--allow-private-ips`.

## Network isolation (NetworkPolicy)

With `networkPolicy.enabled: true` (set in `charts/gateway/values-local.yaml`, `charts/gateway/values-prod.yaml`, `charts/mcp-servers/values-local.yaml` and `charts/mcp-servers/values-prod.yaml`) the `gateway` and `mcp-servers` namespaces start from a default deny, and each connection that is needed has its own allow rule.

- **Reachable from outside the cluster:** the storefront, and the gateway and the dashboard at `gateway.urumi.test`, both through Traefik.
- **Internal only:** woo-mcp, fx-mcp and fetch-mcp accept connections from the gateway pod only. PostgreSQL accepts the gateway pod only. The `store` namespace (WordPress and MariaDB) has no NetworkPolicy yet.

```bash
kubectl get networkpolicy -A
```

The policies, the drills that prove them (with a positive control for each), the results of 17 October 2026 on the local k3d cluster, the commands to run them again and the known limitations are in [docs/network-policy.md](docs/network-policy.md).

## Production-like setup (VPS)

The production-like setup uses the same Helm charts as the local cluster. Only the `values-prod.yaml` file of each chart differs. The running example is one AWS EC2 `m7i-flex.large` (2 vCPU, about 8 GiB of memory) with Ubuntu 26.04 and a 30 GiB gp3 disk, k3s on a single node, an Elastic IP, DuckDNS hostnames and Let's Encrypt certificates from cert-manager. Below, `<your-domain>` is your DuckDNS domain, `<elastic-ip>` the address of the server and `<ssh-host>` the SSH alias of the server. The server is called "the VPS" in this section.

### 1. Firewall, DNS and the instance

Security group: port 22 only from your own IP, ports 80 and 443 from anywhere. Ports 6443 (Kubernetes API) and 10250 (kubelet) stay closed. Require IMDSv2 on the instance, set the metadata hop limit to 1 and attach no IAM role, so a compromised pod cannot read cloud credentials.

DNS: create the A records `store.<your-domain>` and `gateway.<your-domain>`, both pointing at `<elastic-ip>`. Before the next steps, `nslookup store.<your-domain>` must return that address.

### 2. Install k3s, Docker and Helm

Run on the VPS. The cluster of this project runs k3s v1.35.5+k3s1 with secrets encryption at rest. `--write-kubeconfig-mode 600` keeps the kubeconfig readable by its owner only, so copy it to your own home and point `KUBECONFIG` at it:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='v1.35.5+k3s1' sh -s - server --secrets-encryption --write-kubeconfig-mode 600
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown "$USER" ~/.kube/config
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc && export KUBECONFIG=$HOME/.kube/config
kubectl get nodes
```

Docker builds the images. Install Docker Engine from https://docs.docker.com/engine/install/ubuntu/ (`docker-ce` 29.9.1 and `containerd.io` 2.4.2 on this server). Install Helm from https://helm.sh/docs/intro/install/ (v4.3.0 on this server). The k3s Traefik controller and the `local-path` storage class are the defaults and are used as they are.

### 3. Get the code

Create a key pair on the VPS and add the public key to the GitHub repository as a read-only deploy key (Settings, Deploy keys, leave "Allow write access" off). The key never leaves the VPS and cannot push:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/urumi-deploy -N ''
cat ~/.ssh/urumi-deploy.pub
GIT_SSH_COMMAND='ssh -i ~/.ssh/urumi-deploy -o IdentitiesOnly=yes' git clone git@github.com:<owner>/<repository>.git urumi-mcp-gateway
cd urumi-mcp-gateway
git config core.sshCommand 'ssh -i ~/.ssh/urumi-deploy -o IdentitiesOnly=yes'
```

The last command stores the key in the repository config, so a later `git pull` uses the deploy key too.

Then edit the hostnames to your domain (a values file is the place for this, not `--set`). These five keys are the only ones that contain the example domain:

- `charts/store/values-prod.yaml`: `store.host` and `store.admin.email`
- `charts/mcp-servers/values-prod.yaml`: `wooMcp.store.publicUrl` (the same host as `store.host`, with `http://`)
- `charts/gateway/values-prod.yaml`: `ingress.host` and `bootstrap.adminEmail`

### 4. Build the images and import them into k3s

There is no registry. The images are built on the VPS and imported into the containerd of k3s. The values files set `pullPolicy: Never`, so the kubelet uses only the imported images. The tags are the ones in the values files:

```bash
for spec in woo-mcp:0.1.1 fx-mcp:0.1.0 fetch-mcp:0.1.0 gateway:0.11.1 dashboard:0.7.0; do
  sudo docker build -t "$spec" "services/${spec%%:*}"
  sudo docker save "$spec" | sudo k3s ctr images import -
done
sudo k3s ctr images ls | grep -E 'woo-mcp|fx-mcp|fetch-mcp|gateway|dashboard'
```

The images of WordPress and MariaDB are pulled from their registries by the store chart.

### 5. Certificates (cert-manager and the issuers)

Install cert-manager (v1.21.2, with `crds.enabled: true`), then the `cert-issuer` chart, which creates two ClusterIssuers: `letsencrypt-staging` and `letsencrypt-prod` (HTTP-01 through Traefik). The certificates are requested by the Ingress annotations in `values-prod.yaml`, which use `letsencrypt-prod`. Let's Encrypt limits how many certificates it issues per week, so for a first run on a new domain change the annotation `cert-manager.io/cluster-issuer` in the values files to `letsencrypt-staging` (browsers do not trust it), check that the certificates become Ready, and then change it back to `letsencrypt-prod`:

```bash
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version v1.21.2 --namespace cert-manager --create-namespace \
  -f deploy/cert-manager/values.yaml --wait --timeout 5m
helm upgrade --install cert-issuer charts/cert-issuer --namespace cert-manager --wait
```

The `email` value of `cert-issuer` is optional (Let's Encrypt uses it for expiry notices). Port 80 must be reachable from the internet for the HTTP-01 challenge, also for the renewals.

### 6. Install the charts

The same order as local, because the gateway copies the tokens that the `mcp-servers` chart creates, and `mcp-servers` copies its key from the store. No `--set`:

```bash
helm upgrade --install store charts/store -n store --create-namespace -f charts/store/values-prod.yaml --wait --timeout 10m
helm upgrade --install mcp-servers charts/mcp-servers -n mcp-servers --create-namespace -f charts/mcp-servers/values-prod.yaml --wait --timeout 3m
helm upgrade --install gateway charts/gateway -n gateway --create-namespace -f charts/gateway/values-prod.yaml --wait --timeout 5m
kubectl get certificate -A
kubectl get pods -A
```

`store-tls` and `gateway-tls` must show `READY True`, and every pod must be `Running` or `Completed`. The checks `helm test gateway -n gateway` and `helm test mcp-servers -n mcp-servers` work as on the local cluster.

### 7. First admin, chat key and store password

The first admin uses the same invite-token flow as the local setup (gateway step 2), but over https. Run the block of that step on the VPS with these two differences: use `https://gateway.<your-domain>/api/auth/accept-invite` as the URL and `Origin: https://gateway.<your-domain>`. The dashboard is then at `https://gateway.<your-domain>/`.

The Groq key is created with the command of gateway step 7 (`read -rsp` and `kubectl create -f -`, run on the VPS), followed by `kubectl rollout restart deploy/gateway -n gateway`.

To read the WordPress admin password without printing it on the VPS or on your laptop, copy it from your laptop with the clipboard:

```bash
ssh <ssh-host> 'export KUBECONFIG=$HOME/.kube/config; kubectl get secret store-credentials -n store -o jsonpath="{.data.wordpress-admin-password}" | base64 -d' | clip
```

Paste it into the login form at `https://store.<your-domain>/wp-admin/` (user `storeadmin`), then clear the clipboard with `printf '' | clip`.

### What differs from local

| Topic | Local (k3d) | VPS (k3s) |
|---|---|---|
| Hostnames and DNS | `*.urumi.test` in the hosts file | DuckDNS A records to the Elastic IP |
| TLS | none (http) | Let's Encrypt through cert-manager |
| http and https | http only | https only; plain http answers 404 by design |
| Images | built locally, `k3d image import` | built on the VPS, `k3s ctr images import`, `pullPolicy: Never` |
| Storage class | `local-path` | `local-path` |
| Secrets | generated in the cluster | generated in the cluster; k3s encrypts Secrets at rest (`--secrets-encryption`) |

### Cost

An on-demand `m7i-flex.large` in `ap-southeast-2` with a 30 GiB gp3 disk and an Elastic IP is about USD 94 per month all-in (October 2026). Set an AWS budget alert, and stop or terminate the instance when the demo is over.

## Troubleshooting

**Values files are the source of truth.** Change `values-local.yaml` or `values-prod.yaml` of the chart, not the command line. Do not add `--set` flags to `helm install` or `helm upgrade`: a value that is set only on the command line is lost, or silently differs, on the next upgrade.

**SSH says "Connection timed out".** Your home IP address probably changed. Set the SSH rule of the security group to "My IP" again.

**A certificate stays not Ready.** Port 80 must be open to the internet for the HTTP-01 challenge. Run `kubectl describe certificate -n <namespace>` and look at the challenge with `kubectl get challenges -A`.

**`http://` gives 404.** This is expected: only https is routed on the VPS. Use `https://`.
