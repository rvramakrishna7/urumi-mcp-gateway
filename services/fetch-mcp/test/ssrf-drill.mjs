// SSRF drill for the fetch-mcp image (docs/architecture.md, decision 42). It calls the tool "fetch" through the real HTTP
// endpoint with targets that must be refused, plus positive controls that must work, and prints one line per target.
// It prints names, verdicts and short fixed error texts only: never the token and never a fetched body.
//
// Usage: node test/ssrf-drill.mjs <base-url> <token-file> <internal-host> <internal-ip> [--expect-open]
//   internal-host / internal-ip: a canary web server on a private address that the container can reach (port 8000,
//   /canary.txt holding the marker below). --expect-open flips the verdict for the private-address targets: the drill
//   is then run against a container started with --allow-private-ips, to prove that the drill can tell the difference.
import { readFileSync } from 'node:fs';

const [baseUrl, tokenFile, internalHost, internalIp, flag] = process.argv.slice(2);
if (!baseUrl || !tokenFile || !internalHost || !internalIp) {
  console.error('usage: node test/ssrf-drill.mjs <base-url> <token-file> <internal-host> <internal-ip> [--expect-open]');
  process.exit(2);
}
const expectOpen = flag === '--expect-open';
const token = readFileSync(tokenFile, 'utf8').trim();
const MARKER = 'INTERNAL-CANARY-9f3a';
const SELF = '8080';

async function callFetch(url) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch', arguments: { url } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) return { status: response.status, body: '', isError: true, protocolError: true };
  const message = JSON.parse(line.slice(6));
  if (message.error) return { status: response.status, body: String(message.error.message ?? ''), isError: true, protocolError: true };
  const body = (message.result.content ?? []).map((item) => item.text ?? '').join('\n');
  return { status: response.status, body, isError: message.result.isError === true, protocolError: false };
}

// kind "private": the address is private, loopback, link-local or not routable: it must be refused (or reach nothing).
// kind "scheme": not an http(s) URL: it must be refused.
// kind "public": a public address: it must work (a control, so that a drill that refuses everything is not mistaken for a pass).
const targets = [
  ['loopback 127.0.0.1 (the server itself)', `http://127.0.0.1:${SELF}/healthz`, 'private'],
  ['loopback name localhost', `http://localhost:${SELF}/healthz`, 'private'],
  ['loopback IPv6 [::1]', `http://[::1]:${SELF}/healthz`, 'private'],
  ['IPv4-mapped IPv6 [::ffff:127.0.0.1]', `http://[::ffff:127.0.0.1]:${SELF}/healthz`, 'private'],
  ['loopback as a decimal number', `http://2130706433:${SELF}/healthz`, 'private'],
  ['loopback as hex', `http://0x7f000001:${SELF}/healthz`, 'private'],
  ['loopback as octal', `http://0177.0.0.1:${SELF}/healthz`, 'private'],
  ['unspecified 0.0.0.0', `http://0.0.0.0:${SELF}/healthz`, 'private'],
  ['cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/', 'private'],
  ['metadata with a trailing dot name', 'http://169.254.169.254./latest/meta-data/', 'private'],
  ['private 10.0.0.1', 'http://10.0.0.1/', 'private'],
  ['private 172.16.0.1', 'http://172.16.0.1/', 'private'],
  ['private 192.168.0.1', 'http://192.168.0.1/', 'private'],
  ['carrier-grade NAT 100.64.0.1', 'http://100.64.0.1/', 'private'],
  [`internal host by name (${internalHost})`, `http://${internalHost}:8000/canary.txt`, 'canary'],
  [`internal host by IP (${internalIp})`, `http://${internalIp}:8000/canary.txt`, 'canary'],
  ['public name that resolves to 127.0.0.1 (127.0.0.1.nip.io)', `http://127.0.0.1.nip.io:${SELF}/healthz`, 'private'],
  ['userinfo trick: example.com@127.0.0.1', `http://example.com@127.0.0.1:${SELF}/healthz`, 'private'],
  ['redirect: public URL that redirects to the internal host', `https://httpbingo.org/redirect-to?url=${encodeURIComponent(`http://${internalIp}:8000/canary.txt`)}&status_code=302`, 'canary'],
  ['redirect: public URL that redirects to the metadata address', `https://httpbingo.org/redirect-to?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}&status_code=302`, 'private'],
  ['scheme file:///etc/passwd', 'file:///etc/passwd', 'scheme'],
  ['scheme ftp://example.com/', 'ftp://example.com/', 'scheme'],
  ['scheme gopher://example.com/', 'gopher://example.com/', 'scheme'],
  ['CONTROL public: https://example.com', 'https://example.com', 'public'],
];

let failures = 0;
let controlsOk = 0;
for (const [name, url, kind] of targets) {
  let verdict;
  let note = '';
  try {
    const answer = await callFetch(url);
    const leaked = answer.body.includes(MARKER) || /root:x:0:0/.test(answer.body) || (answer.body.trim() === 'ok' && !answer.isError) || /"status"\s*:\s*"ok"/.test(answer.body);
    // Only a short, fixed excerpt of an error text is printed, with digits and addresses left out of the verdict.
    note = answer.isError || answer.protocolError ? answer.body.replace(/\s+/g, ' ').slice(0, 110) : '(content returned)';
    if (kind === 'public') {
      verdict = !answer.isError && /Example Domain|documentation examples/i.test(answer.body) ? 'OK' : 'FAIL (control did not work)';
      if (verdict === 'OK') controlsOk += 1;
    } else if (expectOpen && (kind === 'canary' || kind === 'private')) {
      // With --allow-private-ips the internal canary must be readable: that proves the drill can see the difference.
      if (kind === 'canary' && !redirectKind(name)) verdict = answer.body.includes(MARKER) ? 'OPEN (as expected with --allow-private-ips)' : 'FAIL (not readable although private addresses are allowed)';
      else verdict = leaked ? 'OPEN (as expected with --allow-private-ips)' : 'not readable';
    } else {
      verdict = leaked ? 'FAIL: CONTENT FROM THE TARGET WAS RETURNED' : answer.isError || answer.protocolError ? 'REFUSED' : 'FAIL: no error and no content check possible';
    }
  } catch (error) {
    verdict = 'FAIL (drill error: ' + (error instanceof Error ? error.name : 'unknown') + ')';
  }
  if (verdict.startsWith('FAIL')) failures += 1;
  console.log(`${verdict.padEnd(44)} ${name}  | ${note}`);
}
console.log(`\ntargets: ${targets.length}, public controls that worked: ${controlsOk}, failures: ${failures}`);
process.exit(failures === 0 && controlsOk >= 1 ? 0 : 1);

function redirectKind(name) {
  return name.startsWith('redirect');
}
