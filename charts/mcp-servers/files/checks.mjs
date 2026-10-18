// Checks for woo-mcp, run by "helm test" inside the cluster. They print names, counts and PASS or FAIL.
// No value of the key, the secret or the token is ever printed, and no product or order data is printed.
import { readFileSync } from 'node:fs';

const base = process.env.WOO_MCP_URL;
let failed = false;

function check(name, ok, detail = '') {
  console.log(`[checks] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
}

// This pod is new, and the cluster programs its NetworkPolicy asynchronously: for about a second after the container
// starts, its first connections can be refused. Wait until woo-mcp answers before any check runs, so that start-up
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

await waitFor('woo-mcp', () => call('/healthz'));

// The mounted Secret files exist and are not empty. Only the length is reported.
function fileLength(path) {
  try {
    return readFileSync(path, 'utf8').trim().length;
  } catch {
    return 0;
  }
}
const keyLength = fileLength('/secrets/store-api/consumer-key');
const secretLength = fileLength('/secrets/store-api/consumer-secret');
const token = readFileSync('/secrets/auth/token', 'utf8').trim();
check('store key file', keyLength > 0, `${keyLength} characters`);
check('store secret file', secretLength > 0, `${secretLength} characters`);
check('token file', token.length >= 32, `${token.length} characters`);

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, text: await response.text() };
}

const mcpHeaders = (bearer) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
});

// The Streamable HTTP answer is a server-sent event. The JSON-RPC message is on the "data:" line.
function message(text) {
  const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
  return line ? JSON.parse(line.slice('data: '.length)) : null;
}

try {
  check('GET /healthz', (await call('/healthz')).status === 200);
  check('GET /readyz', (await call('/readyz')).status === 200);

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  check('POST /mcp without a token is refused', (await call('/mcp', { method: 'POST', headers: mcpHeaders(null), body: list })).status === 401);
  check('POST /mcp with a wrong token is refused', (await call('/mcp', { method: 'POST', headers: mcpHeaders(`${token}x`), body: list })).status === 401);

  const listed = await call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: list });
  const tools = (message(listed.text)?.result?.tools ?? []).map((tool) => tool.name);
  check('tools/list with the token', listed.status === 200 && tools.length === 5, `${tools.length} tools: ${tools.join(', ')}`);

  // One real call through WordPress: it proves that the key, the signature and the public URL work together.
  const products = await call('/mcp', {
    method: 'POST',
    headers: mcpHeaders(token),
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_products', arguments: { per_page: 1 } } },
  });
  const result = message(products.text)?.result;
  const count = result && !result.isError ? JSON.parse(result.content[0].text).products.length : -1;
  check('list_products reaches WooCommerce', products.status === 200 && count >= 0, count >= 0 ? `${count} product returned` : 'the tool returned an error');
} catch (error) {
  check('the checks ran without an exception', false, error instanceof Error ? error.name : 'unknown');
}

process.exit(failed ? 1 : 0);
