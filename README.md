# Team MCP Gateway on Kubernetes

WooCommerce store with a team MCP gateway, deployed on Kubernetes with Helm.

The local store and the WooCommerce MCP server are documented so far. The rest is added as it is built and verified.

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

The five tools are `list_products`, `create_product`, `list_orders`, `get_order` and `update_order_status`. `list_orders` takes `date_from` and `date_to` as `today`, `yesterday` or `YYYY-MM-DD`, in the store timezone. No tool returns a customer's email, phone, address or note.

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
docker build -t woo-mcp:0.1.0 services/woo-mcp
k3d image import woo-mcp:0.1.0 -c urumi
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
