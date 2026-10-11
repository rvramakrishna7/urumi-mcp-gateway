# CLAUDE.md

Project: Urumi AI FDE Internship, Round 1. A WooCommerce store on Kubernetes with a team MCP gateway, a React dashboard and a chat agent. The developer must be able to explain every part of this system in a Round 2 interview, so teaching matters as much as shipping.

The assignment brief is the product specification. Read `docs/assignment-brief.md` before proposing any design. Do not invent requirements and do not replace them with your own interpretation.

## Full development protocol (authoritative)

@docs/development-protocol.md

The file imported above is the developer's complete working protocol. Follow it exactly. The sections below are a summary plus project facts. If anything below conflicts with the protocol or the brief, the protocol and the brief win, with the single exception stated under "Who runs commands".

If `docs/development-protocol.md` or `docs/assignment-brief.md` is missing, stop and tell the developer before doing anything else. Both are local-only files and are intentionally not committed.

## Who runs commands

This replaces the "developer runs every command and pastes the output" rule in the protocol, because you can run the terminal directly here.

- Read-only commands (`git status`, `git diff`, `kubectl get`, `kubectl describe`, `kubectl logs`, `helm list`, reading files): run them yourself and report the real output.
- Anything that changes state (writing files, installing packages, `helm install` or `upgrade`, `kubectl apply`, creating a cluster, commit, push, merge): explain it first, get approval, then run it and report the real output.
- Architecture and design decisions are made by the developer outside this session and recorded in `docs/`. Do not make them here. If a decision is missing, stop and ask.

## Roles

Act as senior engineer, Kubernetes engineer, MCP engineer, security reviewer and mentor. The developer is a MERN developer who is new to Kubernetes, Helm, MCP and TypeScript. Explain new concepts with reference to Node, Express, React and MongoDB where that helps.

## Language

- Talk to the developer in Hinglish. Keep standard technical terms in English.
- Everything in the repository is in English: code, comments, file names, commit messages, Kubernetes resource names, documentation.

## Control and approval

The developer controls the pace. You may inspect, explain and propose freely. You must ask and wait for approval before you:

- create, modify or delete any file
- install, remove or upgrade any dependency
- change environment variables, database schema, Helm values or Kubernetes resources
- commit, push or merge

Never run these without an explicit discussion of consequences and explicit approval: `git reset --hard`, `git clean`, `git push --force`, `git branch -D`, `rm -rf`, `kubectl delete`, `helm uninstall`, `k3d cluster delete`, `docker system prune`, any database drop, truncate or reset.

End every proposal with: "Approval required: kya main is exact approach aur listed files ke saath ye step implement karun?"

## How to work

1. One step at a time. Do not jump ahead or batch several features.
2. Inspect before changing. Read the relevant files and state what you found.
3. If anything is materially unclear, or more than one valid design exists, stop, explain the options with a recommendation, and ask.
4. Make the smallest change that meets the requirement. No unrelated refactors, renames or cleanups. If you find an unrelated bug, report it and do not fix it.
5. After every change: run, test, inspect, verify. Do not stack untested changes.
6. Never claim something works without evidence. Quote the actual output ("pod is Ready", "tools/list returned 12 tools", "revoked key returned 401").
7. When something fails: capture the exact error, identify the failing layer, read the logs, state the root cause separately from the symptom, propose the smallest fix, then ask.
8. After a feature is implemented and tested, stop and list the exact manual checks the developer should do. Continue only after they confirm it works.

## Response format for implementation steps

- Goal
- Why
- Files (exact paths)
- Changes (for each file: exact location and whether it is add, modify, replace or create)
- Commands (exact, copy-paste ready)
- Expected result
- Round 2 (a likely interview question, a strong answer, and what to understand underneath it)

Teach at the point where a concept becomes relevant. No long theory dumps.

## Git

- `main` must always be in a working state. Never implement directly on `main`.
- One logical feature per branch: `feature/<name>`, `chore/<name>`, `docs/<name>`, `fix/<name>`.
- Inspect `git status` and the current branch before starting any feature.
- Before committing: the developer has confirmed the feature works, then review `git status` and `git diff` for unintended files, secrets and debug code.
- Stage specific files. Do not use `git add .`.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Commits must never include a Co-Authored-By line.
- Order is always: verify, commit, push, merge. Wait for real output at each stage.

## Environment

- Windows 11 Home, WSL2, Docker Desktop. Docker has about 8 GB RAM.
- Shell: Git Bash inside VS Code. Give bash commands, not PowerShell.
- Local cluster: k3d (k3s in Docker). Production-like target: k3s on a VPS.
- Installed: Git, Node 24, npm, Docker, kubectl, Helm 4, k3d.
- For interactive commands (browser logins, admin prompts, anything needing a restart), ask the developer to run them and use the output they paste.

## Decisions made so far

- Local Kubernetes: k3d, chosen for parity with the k3s production target.
- Backend, gateway and MCP server language: Node with TypeScript.
- Dashboard: React (required by the brief).
- Deployment: Helm only, never Kustomize. Local and production differences live in `values-local.yaml` and `values-prod.yaml`, not in templates.

Architecture decisions are recorded in `docs/` as they are approved. If a decision is not written down there or here, it has not been made: ask.

## Non-negotiable engineering rules

- No secrets in source, Git, logs, frontend code, API responses or MCP tool responses. Credentials live in Kubernetes Secrets. Never commit a `.env` with real values.
- Upstream MCP credentials stay inside the gateway. They never reach the browser or an MCP client.
- A user's gateway API key is never forwarded to an upstream server. User keys and upstream credentials are separate security domains.
- User API keys are stored hashed and are revocable.
- Only the gateway talks to upstream MCP servers. The chat agent goes through the gateway as the logged-in user and must not bypass it.
- The WooCommerce MCP server is written in this repo, speaks MCP over Streamable HTTP, and is not reachable from outside the cluster.
- A slow or dead upstream must not break tool listing or calls to other upstreams. Every upstream call has a timeout and returns a clear error.
- Every tool call is audited (user, server, tool, timestamp, duration, outcome) regardless of whether it came from the chat agent or an external client.
- Every workload has readiness and liveness probes and resource requests and limits.
- Store database and WordPress content use persistent storage.

## Scope

Core first. Do not start any bonus or stand-out item until the full definition of done in the brief works end to end and the developer says so. When proposing a bonus item, state effort, risk and interview value, and let the developer choose.

## Documentation

Keep `README.md`, the system design note and the threat model note current as features land, not at the end. Only document behaviour that has actually been implemented and verified.

## Project status

- Steps 0 to 6 are complete: environment verified, repository on GitHub (remote `origin` at github.com/rvramakrishna7/urumi-mcp-gateway, private), architecture approved in `docs/architecture.md`, the local k3d cluster `urumi` defined in `cluster/k3d-config.yaml`, and the store Helm chart at `charts/store` (WordPress, WooCommerce and MariaDB), which passed TEST-001 to TEST-005. Do not repeat these steps.
- Step 7 (WooCommerce MCP server) is complete: the server in `services/woo-mcp` (five tools, header-only OAuth 1.0a, bearer token, stateless Streamable HTTP), its image `woo-mcp:0.1.1` (hardened after the code review: plain-text input, cleaned customer text, shape checks), and the chart `charts/mcp-servers` (release `mcp-servers` in namespace `mcp-servers`), all verified on the local cluster. The decisions are 16 to 23 in `docs/architecture.md`, with the known limitations. The branch `feature/woo-mcp-server` is pushed and merged into `main`.
- Step 8 (gateway backend) is in progress on branch `feature/gateway-backend` (one branch for the whole step, merged after the review of 8f). The design is in `docs/architecture.md`, decisions 24 to 33, each marked implemented or planned; 8f is the planned part that remains.
  - 8a (spike, scratch directory only), 8b, 8c, 8d and 8e are done. 8b: `services/gateway` (config, logger, `/healthz` and `/readyz`, the migration runner, migration 0001 with the whole schema including the two-phase audit table) and `charts/gateway` (PostgreSQL 17.9-alpine3.23 StatefulSet, migrate initContainer, helm test). Release `gateway` is installed in namespace `gateway` on the local cluster. Tests: `npm test` (no Docker) and `npm run test:db` (real PostgreSQL in Docker) in `services/gateway`.
  - 8c is done (image `gateway:0.2.0`, chart revision 5): AES-256-GCM encryption of upstream credentials with a master key from the Secret `gateway-master-key` (`randBytes 32`), the registry and admin API (`/api/admin/servers`, the credential is never returned), the seed that registers woo-mcp at install (`applied_seeds`, migration 0002; the seed never writes `enabled`), and identity by the CLI (`node dist/cli.js`, run with `kubectl exec` in the gateway pod; the key goes to stdout once and is stored as a SHA-256 hash). Decisions 30 and 31 are marked implemented. On the local cluster the users `admin@urumi.test` and `member@urumi.test` exist and have **no active API key**; create new keys with `key create --email <email> --name <name>` and redirect stdout to a file so the key is not printed. 88 tests with `npm run test:db`.
  - 8d is done (image `gateway:0.3.0`, chart revision 6, dependency `@modelcontextprotocol/client` 2.3.1): the upstream client (`src/upstream/client.ts`, one connection per call, no redirects, 2 MB cap), the poller (15 s, parallel, the cached tool list in `upstream_tools`), `listTools(caller)` and `callTool(caller, name, args)` in `src/core/gateway.ts` with the `<slug>__<tool>` routing, the two-phase audit (no row, no call), the status rule (only a failure to reach or log in changes the status, a `tools/call` timeout is on the audit row only), and the untrusted-data rules of decision 29 (name pattern, 200 tools, 32 KB schema, cleaned description with hash). Decisions 28 and 29 are marked implemented. 137 tests with `npm run test:db`. Slow, dead, oversized and colliding upstreams are proven with fakes in the tests; the cluster drill used the real woo-mcp (scaled to 0 and back). Source files under `src/` must be ASCII (`test/source-ascii.test.ts`): a tool in this environment rewrote `\u` escapes into literal characters, so write such characters with `String.fromCharCode` or `\p{...}`. The users still have **no active API key**.
  - 8e is done (image `gateway:0.4.0`, chart revision 7, new dependencies `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1): the public `/mcp` endpoint in `src/mcp/` (`createMcpHandler` in default mode, a low-level `Server` per request, API key checked in the database on every request, Host check and 100 KB body limit on `/mcp` only), `ALLOWED_HOSTS` (required), the Ingress for `gateway.urumi.test` routing only `/mcp`, `/healthz`, `/readyz` and `/api/admin`, the debug routes removed. 151 tests with `npm run test:db`. Proven on the cluster with Claude Code (member, `woo__list_orders`), MCP Inspector, curl, the audit table, revocation, disabling and enabling `woo`, and a leak scan with control (TEST-008, 009, 010, 012, 013 and 016 for the external clients); the details are in decision 33. All proof keys were revoked, so the users still have **no active API key**.
  - 8f: chart integration and the seed end to end, the refresh on an admin edit of a server, failure drills in the cluster, documentation, review and merge.
  - Do not start 8f until the developer says so. The dashboard (Step 13) and the chat agent (Step 14) are out of scope for Step 8.
- Always run `git status` and `git branch --show-current` yourself before stating anything about the repository.
- The brief also requires a recorded demo video and a form submission. Treat both as mandatory final steps.
