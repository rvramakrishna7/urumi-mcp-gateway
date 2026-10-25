# CLAUDE.md

A WooCommerce store on Kubernetes, with a team MCP gateway (one public MCP endpoint over several upstream
MCP servers), a React dashboard and a chat agent that calls tools through the gateway. See README.md for
setup and docs/ for the design, the threat model and the network policies.

## Repository layout

- `charts/store`: WordPress, WooCommerce and MariaDB.
- `charts/mcp-servers`: woo-mcp, fx-mcp and fetch-mcp (not reachable from outside the cluster).
- `charts/gateway`: gateway, PostgreSQL and dashboard. `charts/cert-issuer`: Let's Encrypt issuers.
- `services/gateway`, `services/woo-mcp`, `services/fx-mcp`, `services/dashboard`: Node and TypeScript.
- `services/fetch-mcp`: Python. `cluster/`: local k3d config. `deploy/`: cert-manager values.

## Commands

- Node services (run in the service directory): `npm test`, `npm run typecheck`, `npm run build`.
- Gateway tests that need PostgreSQL (Docker required): `npm run test:db` in `services/gateway`.
- There is no lint script. Charts: `helm lint charts/<name>` and `helm template`.

## Engineering rules

- Helm only. Differences between environments live in `values-local.yaml` and `values-prod.yaml`.
- Do not use `--set` for configuration; put values in a values file.
- No secrets in source, Git, logs, API responses or tool responses. Credentials live in Kubernetes Secrets.
- Upstream credentials stay inside the gateway. A user's gateway API key is never forwarded upstream.
- API keys are stored hashed and are revocable. Every tool call is written to the audit log.
- Every workload has readiness and liveness probes and resource requests and limits.
- Source files and docs are English and ASCII. Make the smallest change that meets the requirement.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) and one branch per change.

## AI assistance

AI tools were used to write parts of this repository. The author reviewed the result and can explain every
part of it.
