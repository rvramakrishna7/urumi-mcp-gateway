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
- Every API-key operation that is exposed over HTTP (list, create, revoke) is scoped by the caller's user id in the SQL itself (`WHERE user_id = $caller`), not by a check in application code afterwards, so one member can never see or revoke another member's key. An admin operation on another user's keys is a separate, explicit route with its own role check. Implemented in Step 10: `/api/me/keys` (session only, the user id from the session) and `/api/admin/users/:id/keys` (admin only, both ids in the SQL).
- Only the gateway talks to upstream MCP servers. The chat agent goes through the gateway as the logged-in user and must not bypass it.
- The WooCommerce MCP server is written in this repo, speaks MCP over Streamable HTTP, and is not reachable from outside the cluster.
- A slow or dead upstream must not break tool listing or calls to other upstreams. Every upstream call has a timeout and returns a clear error.
- Every tool call is audited (user, server, tool, timestamp, duration, outcome) regardless of whether it came from the chat agent or an external client.
- Every workload has readiness and liveness probes and resource requests and limits.
- Store database and WordPress content use persistent storage.
- Every leak scan must assert the number of needles it loaded (a minimum, checked, not printed as information) and must include a planted positive control that the scan has to find. A scan that loads fewer needles than intended reports "0 matches" and looks clean; the bug "a read loop drops the last line of a file without a trailing newline" has happened more than once (the passwords, the bootstrap token, the master key and the database password were missing from one scan, and only the control showed it).
- Never print a rendered or live manifest unfiltered (`helm template`, `helm get manifest`, `kubectl get ... -o yaml`, or a `diff` of them). Drop every Secret document before any diff or print, and check the filter with a planted control (a fake Secret document with a marker value that must be absent from the filtered output, plus a count of the documents kept). A rendering that fails halfway makes `diff` print one whole side, so build the filtered files first and diff only those. This happened once in 10e: three Secrets of the local cluster reached the transcript (see the open item for step 19).

## Scope

Core first. Do not start any bonus or stand-out item until the full definition of done in the brief works end to end and the developer says so. When proposing a bonus item, state effort, risk and interview value, and let the developer choose.

## Documentation

Keep `README.md`, the system design note and the threat model note current as features land, not at the end. Only document behaviour that has actually been implemented and verified.

## Project status

- Steps 0 to 6 are complete: environment verified, repository on GitHub (remote `origin` at github.com/rvramakrishna7/urumi-mcp-gateway, private), architecture approved in `docs/architecture.md`, the local k3d cluster `urumi` defined in `cluster/k3d-config.yaml`, and the store Helm chart at `charts/store` (WordPress, WooCommerce and MariaDB), which passed TEST-001 to TEST-005. Do not repeat these steps.
- Step 7 (WooCommerce MCP server) is complete: the server in `services/woo-mcp` (five tools, header-only OAuth 1.0a, bearer token, stateless Streamable HTTP), its image `woo-mcp:0.1.1` (hardened after the code review: plain-text input, cleaned customer text, shape checks), and the chart `charts/mcp-servers` (release `mcp-servers` in namespace `mcp-servers`), all verified on the local cluster. The decisions are 16 to 23 in `docs/architecture.md`, with the known limitations. The branch `feature/woo-mcp-server` is pushed and merged into `main`.
- Step 8 (gateway backend) is complete and merged into `main` (branch `feature/gateway-backend`, one branch for the whole step; `main` was at `3ffdf38` after the merge). The design is in `docs/architecture.md`, decisions 24 to 34, all marked implemented.
  - 8a (spike, scratch directory only), 8b, 8c, 8d and 8e are done. 8b: `services/gateway` (config, logger, `/healthz` and `/readyz`, the migration runner, migration 0001 with the whole schema including the two-phase audit table) and `charts/gateway` (PostgreSQL 17.9-alpine3.23 StatefulSet, migrate initContainer, helm test). Release `gateway` is installed in namespace `gateway` on the local cluster. Tests: `npm test` (no Docker) and `npm run test:db` (real PostgreSQL in Docker) in `services/gateway`.
  - 8c is done (image `gateway:0.2.0`, chart revision 5): AES-256-GCM encryption of upstream credentials with a master key from the Secret `gateway-master-key` (`randBytes 32`), the registry and admin API (`/api/admin/servers`, the credential is never returned), the seed that registers woo-mcp at install (`applied_seeds`, migration 0002; the seed never writes `enabled`), and identity by the CLI (`node dist/cli.js`, run with `kubectl exec` in the gateway pod; the key goes to stdout once and is stored as a SHA-256 hash). Decisions 30 and 31 are marked implemented. On the local cluster the users `admin@urumi.test` and `member@urumi.test` exist and have **no active API key**; create new keys with `key create --email <email> --name <name>` and redirect stdout to a file so the key is not printed. 88 tests with `npm run test:db`.
  - 8d is done (image `gateway:0.3.0`, chart revision 6, dependency `@modelcontextprotocol/client` 2.3.1): the upstream client (`src/upstream/client.ts`, one connection per call, no redirects, 2 MB cap), the poller (15 s, parallel, the cached tool list in `upstream_tools`), `listTools(caller)` and `callTool(caller, name, args)` in `src/core/gateway.ts` with the `<slug>__<tool>` routing, the two-phase audit (no row, no call), the status rule (only a failure to reach or log in changes the status, a `tools/call` timeout is on the audit row only), and the untrusted-data rules of decision 29 (name pattern, 200 tools, 32 KB schema, cleaned description with hash). Decisions 28 and 29 are marked implemented. 137 tests with `npm run test:db`. Slow, dead, oversized and colliding upstreams are proven with fakes in the tests; the cluster drill used the real woo-mcp (scaled to 0 and back). Source files under `src/` must be ASCII (`test/source-ascii.test.ts`): a tool in this environment rewrote `\u` escapes into literal characters, so write such characters with `String.fromCharCode` or `\p{...}`. The users still have **no active API key**.
  - 8e is done (image `gateway:0.4.0`, chart revision 7, new dependencies `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1): the public `/mcp` endpoint in `src/mcp/` (`createMcpHandler` in default mode, a low-level `Server` per request, API key checked in the database on every request, Host check and 100 KB body limit on `/mcp` only), `ALLOWED_HOSTS` (required), the Ingress for `gateway.urumi.test` routing only `/mcp`, `/healthz`, `/readyz` and `/api/admin`, the debug routes removed. 151 tests with `npm run test:db`. Proven on the cluster with Claude Code (member, `woo__list_orders`), MCP Inspector, curl, the audit table, revocation, disabling and enabling `woo`, and a leak scan with control (TEST-008, 009, 010, 012, 013 and 016 for the external clients); the details are in decision 33. All proof keys were revoked, so the users still have **no active API key**.
  - 8f is done (image `gateway:0.5.0`, chart revision 8, `package.json` version 0.5.0): the review fixes (a changed or lost master key no longer crash-loops the gateway: the seed re-encrypts, and a server with an unreadable credential is `unreachable` with the reason `credential_unreadable`), `/readyz` is not routed by the Ingress, one `VERSION` in `src/version.ts`, CLI usage on `--help`, the refresh of the poller after an admin creates or edits a server, and the documentation (README gateway section, decision 34, known limitations). 166 tests with `npm run test:db`. Proven on the cluster: `/readyz` 404 through the Ingress, `woo2` registered and its tools listed at once, `woo__list_products` returns Test Mug, leak scan with control. All proof keys were revoked, so the users still have **no active API key**.
  - The dashboard (Step 13) and the chat agent (Step 14) are out of scope for Step 8. Do not start the next step until the developer says so.
- Step 10 (dashboard login and key management API, backend only, no React) is **complete** on branch `feature/dashboard-auth-api` (one branch for the whole step; it is merged into `main` only after the developer reviews the full diff of the step, which is not done yet). The design is in `docs/architecture.md`, decisions 35 to 37, marked implemented. Sub-steps: 10a docs; 10b migration 0003 (`sessions`, `login_throttle`, `users.last_login_at`) and argon2id password hashing; 10c sessions, login, logout, `/api/auth/me`, the per-email throttle, the Origin check, the admin API accepting a session (no per-IP lock, decision 37); 10d accept-invite, the bootstrap admin from the Secret `gateway-bootstrap`, the CLI `user invite` (image `gateway:0.6.0`, cluster proof 1 with 62 checks); 10e `/api/me/keys` scoped by user id in SQL (0.6.1); 10f the admin routes `/api/admin/users` (list, create a member, invite, disable and enable, the keys of a user, revoke a key; an admin cannot invite an admin, cannot disable himself, and the last active admin cannot be disabled), the README (gateway section, first-admin command tested in Git Bash), and cluster proof 2 (image `gateway:0.6.2`, chart revision 11, 48 checks passed in the final run, TEST-012 shown, leak scan with 8 needles and a planted control). No new dependency in the whole step. There is no password change route: a re-invite is the reset path, and the password of an admin is reset with the CLI only. The last-admin guard is proven by the race test and a mutation check, **not seen live in the cluster**. Tests: 291 with `npm run test:db` (serial). **State of the local cluster:** `admin@urumi.test` (the real admin, has a password) and `member@urumi.test` are active; all four throwaway accounts (`proof-d-admin`, `proof-d-member`, `proof-f-member`, `proof-g-member`) are disabled, and **no user has an active API key**. Disabling a user does not revoke their keys (they stop while the user is disabled). The command for the first admin in the README uses `printf` and `sed`, not `node`, because in Git Bash `node` is an alias for `winpty node.exe`, which refuses to run in a pipe. **Review fix after 10f (image `gateway:0.6.3`, chart revision 12, 295 tests):** the login throttle was check-then-act, so a burst of parallel logins for one email all got a password verdict (27 or 28 of 29 wrong passwords answered 401 and the correct one got 200, 4 of 4 rounds in `test/login-throttle-race.test.ts`). Now the lock is checked again after the hash, for a right and a wrong password alike (a recheck for the wrong one alone would be an oracle); the test passes 12 of 12 rounds. It is not an exact bound: 9 to 16 of 29 wrong passwords still got a verdict in a burst, and an atomic reservation of the attempt before the hash (proposed in decision 35, not built) would make it exactly 5. Known limitations also list that the `lastTouch` maps are never pruned. **Open item:** the timing test "a slow upstream does not delay the list or a call to another upstream (measured)" in `test/gateway-core.test.ts` failed once in 7 full `npm run test:db` runs under parallel load, after the argon2 tests were added, and passed in the runs before and after; the root cause is not confirmed and the test is unchanged. Look at it before the final definition-of-done run. **Update on the timing test:** it failed 2 of 2 under parallel load (the poll took 1249 and 1532 ms, the limit is 1200) and passed 19 of 19 full serial runs (about 640 to 870 ms), so `scripts/test-db.sh` now runs `node --test --test-concurrency=1`; the thresholds and the test are unchanged. The parallel cause is measured as load, not confirmed as one file. **Open item (leak scan, not fixed):** `leak scan: no URL, port, credential or upstream body ...` in `test/gateway-core.test.ts` failed once in about 40 runs. The assertion message was lost (the output had been piped through grep), and the failure did not come back in 25 runs of the file alone or in 12 full serial runs after it. One unexplained failure in ~40 runs; the measured false-match rate of a bare port needle is 0.3% per run (a fake port is a substring of a UUID in the database text of the scan), so that cause is plausible but not proven. The port needles are now matched with boundaries (`test/helpers/port-needle.ts`), which removes that one cause only; if the scan fails again, a real leak is not ruled out until the message shows the needle. Full logs of every run are now kept, never piped through grep. **Open item for step 17 (security), proposed and not built:** the login throttle does not bound the number of password verdicts in a burst of parallel requests (9 to 16 of 29 wrong passwords still got a verdict after the recheck of 0.6.3, measured). Reserving the attempt before the hash with one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` would make it exactly 5 (decision 35); it changes the meaning of the column `failures` to attempts, so it needs the developer's decision. **Open item for step 19 (secrets):** in the 10e session an unfiltered `diff` of the live manifest of the release `gateway` printed the base64 values of the Secrets `gateway-bootstrap`, `gateway-master-key` and `gateway-db` of the local cluster into the transcript. Nothing reached the repository. The developer accepted the risk for the local cluster and does not rotate now; step 19 recreates the cluster with new secrets, and those three must not be carried over (the bootstrap token was already used, so it is the least sensitive).
- Step 12 (the audit log API, backend only) is **complete** on branch `feature/audit-api` (not merged: the developer reviews `../audit-api-review.txt` first). Design: decision 38, marked implemented. 12a docs; 12b migration 0004 (one index, `audit_log (user_id, id DESC)`) and `src/audit/query.ts` (scope in SQL, keyset on `id`); 12c `GET /api/audit` in `src/routes/audit.ts` (session only; admin sees all rows, a member only their own, `userId` from a member is 400), the Ingress prefix `/api/audit`, `nosniff` on every answer, the two stale Ingress comments fixed (and the same list in `NOTES.txt`), image `gateway:0.7.0`, chart revision 13. 351 tests with `npm run test:db`; two mutation checks; cluster proof 32 checks passed with three throwaway users. The planner uses the new index only on a large table (100000 rows), not at a few hundred (decision 38). **State of the local cluster:** `proof-h-m1-*` and `proof-h-m2-*` are disabled, all proof keys are revoked, and the throwaway admin `proof-h-admin-*` is still **active** (an admin cannot disable himself): the developer disables it through the admin route of the real admin `admin@urumi.test`. Next: Step 13, the dashboard (plan approved, decisions: nginx pod, Servers screen admin only, design direction "Circuit"); nothing of it is started.
- Always run `git status` and `git branch --show-current` yourself before stating anything about the repository.
- The brief also requires a recorded demo video and a form submission. Treat both as mandatory final steps.
