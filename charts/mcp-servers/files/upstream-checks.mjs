// Checks for a token-protected upstream (fx-mcp or fetch-mcp), run by "helm test" inside the cluster.
// They print names, counts and PASS or FAIL. No token and no tool result is ever printed.
// Settings come from the environment: UPSTREAM_URL, EXPECTED_TOOLS (comma separated), HEALTH_PATHS (comma separated).
import { readFileSync } from 'node:fs';

const base = process.env.UPSTREAM_URL;
const expectedTools = (process.env.EXPECTED_TOOLS ?? '').split(',').filter(Boolean).sort();
const healthPaths = (process.env.HEALTH_PATHS ?? '/healthz').split(',').filter(Boolean);
let failed = false;

function check(name, ok, detail = '') {
  console.log(`[checks] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
}

// This pod is new, and the cluster programs its NetworkPolicy asynchronously: for about a second after the container
// starts, its first connections can be refused. Wait until the upstream answers before any check runs, so that start-up
// timing is not reported as a failure of the checks. ("call" is declared below; function declarations are hoisted.)
const WAIT_LIMIT_MS = 20_000;
const WAIT_STEP_MS = 500;

async function waitFor(target, attempt) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown';
      console.log(`[checks] waiting for ${target}: ${code}`);
      if (Date.now() >= deadline) {
        console.log(`[checks] FAIL ${target} did not answer within ${WAIT_LIMIT_MS / 1000} s (${code})`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
  }
}

await waitFor('the upstream', () => call(healthPaths[0] ?? '/healthz'));

let token = '';
try {
  token = readFileSync('/secrets/auth/token', 'utf8').trim();
} catch {
  // reported by the check below
}
check('token file', token.length >= 32, `${token.length} characters`);

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

const mcpHeaders = (bearer) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
});

// The Streamable HTTP answer is a server-sent event ("data:" line) or plain JSON.
function message(text) {
  const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
  try {
    return JSON.parse(line ? line.slice('data: '.length) : text);
  } catch {
    return null;
  }
}

try {
  for (const path of healthPaths) {
    check(`GET ${path}`, (await call(path)).status === 200);
  }

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  check('POST /mcp without a token is refused', (await call('/mcp', { method: 'POST', headers: mcpHeaders(null), body: list })).status === 401);
  check('POST /mcp with a wrong token is refused', (await call('/mcp', { method: 'POST', headers: mcpHeaders(`${token}x`), body: list })).status === 401);

  const listed = await call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: list });
  const tools = (message(listed.text)?.result?.tools ?? []).map((tool) => tool.name).sort();
  check('tools/list with the token', listed.status === 200 && JSON.stringify(tools) === JSON.stringify(expectedTools), `${tools.length} tools: ${tools.join(', ')}`);
} catch (error) {
  check('the checks ran without an exception', false, error instanceof Error ? error.name : 'unknown');
}

process.exit(failed ? 1 : 0);
