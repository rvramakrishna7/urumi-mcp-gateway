# Team MCP Gateway on Kubernetes

WooCommerce store with a team MCP gateway, deployed on Kubernetes with Helm.

The local store, the WooCommerce MCP server and the gateway backend are documented so far. The rest is added as it is built and verified.

## Local setup

This section covers the store (WordPress, WooCommerce and MariaDB). It was tested on Windows 11 with WSL2, Docker Desktop (about 8 GB of memory) and Git Bash. Run the commands from the repository root.

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

The password is generated inside the cluster on first install and kept in the Kubernetes Secret `store-credentials`. It is never written to Git or to logs. Read it in your own terminal:

```bash
kubectl get secret store-credentials -n store -o jsonpath='{.data.wordpress-admin-password}' | base64 -d; echo
```

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

### 2. Build the image and import it into the cluster

```bash
docker build -t woo-mcp:0.1.1 services/woo-mcp
k3d image import woo-mcp:0.1.1 -c urumi
```

The image is based on `node:24.21.0-alpine3.24`, contains only the compiled code and the production dependencies, and runs as user 10001. The chart uses `imagePullPolicy: IfNotPresent`, so the imported image is used and nothing is pulled.

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

The pod should be `1/1 Running` with 0 restarts, the Service should be `ClusterIP`, and there should be no Ingress. The test pod prints PASS lines (names and counts only, never a secret): the mounted files exist, `/healthz` and `/readyz` answer, `/mcp` refuses a missing or wrong token, `tools/list` returns 5 tools, and `list_products` reaches WooCommerce.

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

The gateway keeps the list of upstream MCP servers, offers one public MCP endpoint (`/mcp`) to clients with a user API key, and writes an audit row for every tool call. Install the store and mcp-servers charts first (the sections above): the gateway chart copies the woo-mcp token from the Secret `woo-mcp-auth` and registers woo-mcp at install, and the install stops with a message if that Secret is missing. The hosts file entry for `gateway.urumi.test` is the one from step 2 of the local setup. Run the commands from the repository root. The tests of the gateway are in `services/gateway`: `npm test` needs no Docker, and `npm run test:db` starts a throwaway PostgreSQL in Docker and runs everything.

### 1. Build the image and install the chart

```bash
docker build -t gateway:0.5.0 services/gateway
k3d image import gateway:0.5.0 -c urumi

helm upgrade --install gateway charts/gateway \
  --namespace gateway --create-namespace \
  -f charts/gateway/values-local.yaml \
  --wait --timeout 5m
helm test gateway -n gateway
kubectl logs -n gateway pod/gateway-checks
```

The release has PostgreSQL (a StatefulSet with a persistent volume) and the gateway Deployment. A `migrate` initContainer creates the schema before the server starts. The test pod prints PASS lines (names and counts only): the database, the migrations, the tables, the seeded server `woo` with an encrypted credential, and the public routes. The Ingress routes only `/mcp`, `/healthz` and `/api/admin`: `curl -i http://gateway.urumi.test/readyz` answers 404 on purpose.

### 2. Create a user and a key

There is no login yet (the dashboard comes later), so users and keys are made with the command-line tool inside the gateway pod. The new key is the only thing on stdout; redirect it to a file so that it is not printed, and keep that file private:

```bash
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js user create --email admin@urumi.test --role admin
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js user create --email member@urumi.test --role member

umask 077
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js key create --email member@urumi.test --name laptop > member.key
kubectl exec -n gateway deploy/gateway -c gateway -- node dist/cli.js key create --email admin@urumi.test --name admin-laptop > admin.key
```

The key starts with `mcpgw_`. The gateway stores only its SHA-256 hash, so it cannot be shown again; make a new one if it is lost. Other commands: `user list`, `key list --email <email>` and `key revoke --id <key id>` (a revoked key gets 401 on the very next request). `--help` prints the usage. Do not commit key files.

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

### 5. Read the audit log

Every tool call has a row, written before the call and finished after it, whether it came from an external client or (later) the chat agent. There is no audit page yet; read the table:

```bash
kubectl exec -n gateway postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT ts, user_email, via, server_slug, tool, outcome, error_kind, duration_ms FROM audit_log ORDER BY id DESC LIMIT 10"'
```

`outcome` is `ok`, `error`, `timeout`, `unreachable` or `unknown_tool`; `via` is `mcp` for an external client. Arguments and results are never stored.
