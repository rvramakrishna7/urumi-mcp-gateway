# Team MCP Gateway on Kubernetes

WooCommerce store with a team MCP gateway, deployed on Kubernetes with Helm.

Only the local store setup is documented so far. The rest is added as it is built and verified.

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
