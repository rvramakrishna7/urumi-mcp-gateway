import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpstreamUrl, isBlockedHost, parseUpstreamPolicy, UpstreamPolicyError } from '../src/upstream/ssrf.ts';
import type { UrlBlockReason } from '../src/upstream/ssrf.ts';

const OWN_NAMESPACE = 'gateway';
const REAL_HOSTS = [
  'woo-mcp.mcp-servers.svc.cluster.local:8080',
  'fx-mcp.mcp-servers.svc.cluster.local:8080',
  'fetch-mcp.mcp-servers.svc.cluster.local:8080',
];
const policy = parseUpstreamPolicy(REAL_HOSTS.join(','), OWN_NAMESPACE);
const WOO = 'woo-mcp.mcp-servers.svc.cluster.local';

function verdict(value: string) {
  return checkUpstreamUrl(policy, OWN_NAMESPACE, value);
}

function expectReason(value: string, reason: UrlBlockReason) {
  assert.deepEqual(verdict(value), { ok: false, reason }, value);
}

describe('checkUpstreamUrl', () => {
  test('the three real upstreams are allowed', () => {
    for (const host of REAL_HOSTS) assert.deepEqual(verdict(`http://${host}/mcp`), { ok: true }, host);
  });

  test('an upper case host, a trailing dot and https on the same host and port are allowed', () => {
    assert.deepEqual(verdict(`http://WOO-MCP.MCP-SERVERS.SVC.CLUSTER.LOCAL:8080/mcp`), { ok: true });
    assert.deepEqual(verdict(`http://${WOO}.:8080/mcp`), { ok: true });
    assert.deepEqual(verdict(`https://${WOO}:8080/mcp`), { ok: true });
  });

  test('every IP literal is refused as ip_literal, in every encoding', () => {
    const literals = [
      '169.254.169.254', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '0.0.0.0', '10.43.0.1', '10.43.240.125',
      '[::1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[fd00:ec2::254]', '[fe80::1]',
    ];
    for (const literal of literals) {
      expectReason(`http://${literal}/mcp`, 'ip_literal');
      expectReason(`http://${literal}:8080/mcp`, 'ip_literal');
    }
  });

  test('this machine, the Kubernetes API and the own namespace are blocked_host', () => {
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'kubernetes.default.svc', 'kubernetes.default.svc.cluster.local', 'postgres.gateway.svc.cluster.local']) {
      expectReason(`http://${host}:8080/mcp`, 'blocked_host');
    }
  });

  test('a single-label name is blocked_host, because the pod DNS search list would resolve it in the own namespace', () => {
    expectReason('http://postgres:5432/', 'blocked_host');
    expectReason('http://woo-mcp:8080/mcp', 'blocked_host');
    expectReason('http://POSTGRES.:5432/', 'blocked_host');
  });

  test('a host or port that is not on the list is host_not_allowed', () => {
    expectReason(`http://${WOO}/mcp`, 'host_not_allowed');
    expectReason(`http://${WOO}:8081/mcp`, 'host_not_allowed');
    expectReason('http://woo-mcp.other-ns.svc.cluster.local:8080/mcp', 'host_not_allowed');
    expectReason('http://evil.example.com:8080/mcp', 'host_not_allowed');
    expectReason('http://mcp-servers.svc.cluster.local:8080/mcp', 'host_not_allowed');
  });

  test('an IDN host becomes punycode and is still not allowed', () => {
    const idn = `m${String.fromCharCode(0xfc)}nchen.example`;
    expectReason(`http://${idn}:8080/mcp`, 'host_not_allowed');
    assert.equal(new URL(`http://${idn}/`).hostname, 'xn--mnchen-3ya.example');
  });

  test('user information is refused as userinfo, so the real host was parsed correctly', () => {
    expectReason(`http://user:pass@${WOO}:8080/mcp`, 'userinfo');
    expectReason(`http://evil.com@${WOO}:8080/mcp`, 'userinfo');
  });

  test('a scheme other than http and https is scheme_not_allowed', () => {
    expectReason(`ftp://${WOO}:8080/mcp`, 'scheme_not_allowed');
    expectReason('file:///etc/passwd', 'scheme_not_allowed');
    expectReason('gopher://evil.example.com:70/', 'scheme_not_allowed');
  });

  test('something that is not a URL is invalid_url, and the function does not throw', () => {
    expectReason('not a url', 'invalid_url');
    expectReason('', 'invalid_url');
  });

  test('the answer never carries the URL', () => {
    const marker = 'secret-marker-9f3a';
    assert.doesNotMatch(JSON.stringify(verdict(`http://${marker}.example.com:8080/mcp`)), new RegExp(marker));
  });
});

describe('isBlockedHost', () => {
  test('the own namespace rule uses the namespace that is given', () => {
    assert.equal(isBlockedHost('postgres.gateway.svc.cluster.local', 'gateway'), true);
    assert.equal(isBlockedHost('postgres.gateway.svc', 'gateway'), true);
    assert.equal(isBlockedHost('postgres.gateway', 'gateway'), true);
    assert.equal(isBlockedHost('gateway', 'gateway'), true);
    assert.equal(isBlockedHost('postgres.gateway.svc.cluster.local', 'other'), false);
    assert.equal(isBlockedHost('postgres.other.svc.cluster.local', 'other'), true);
  });

  test('a single-label name is blocked whatever the namespace is', () => {
    assert.equal(isBlockedHost('postgres', 'gateway'), true);
    assert.equal(isBlockedHost('woo-mcp', 'gateway'), true);
  });

  test('a name that only ends with the letters of the namespace is not blocked', () => {
    assert.equal(isBlockedHost('woo-mcp.notgateway.svc.cluster.local', 'gateway'), false);
  });
});

describe('parseUpstreamPolicy', () => {
  test('the real three-entry string is accepted, with spaces around the commas', () => {
    const parsed = parseUpstreamPolicy(`  ${REAL_HOSTS[0]} , ${REAL_HOSTS[1]} ,${REAL_HOSTS[2]}  `, OWN_NAMESPACE);
    assert.deepEqual([...parsed.allowed].sort(), [...REAL_HOSTS].sort());
  });

  test('upper case and a trailing dot are normalized', () => {
    const parsed = parseUpstreamPolicy('WOO-MCP.MCP-SERVERS.SVC.CLUSTER.LOCAL.:8080', OWN_NAMESPACE);
    assert.deepEqual([...parsed.allowed], [REAL_HOSTS[0]]);
  });

  test('a list with an empty entry between commas keeps the other entries', () => {
    assert.deepEqual([...parseUpstreamPolicy(`${REAL_HOSTS[0]},,`, OWN_NAMESPACE).allowed], [REAL_HOSTS[0]]);
  });

  const BAD = [
    '', ' , ', '*', '*.mcp-servers.svc.cluster.local:8080', 'woo-mcp.mcp-servers.svc.cluster.local', ':8080', 'host:0', 'host:65536',
    'host:abc', 'http://host:8080', '10.43.0.1:8080', '[::1]:8080', 'localhost:8080', 'kubernetes.default.svc:443',
    'postgres.gateway.svc.cluster.local:5432', 'postgres:5432', 'woo-mcp:8080',
    // Extra shapes of the same problems.
    '127.1:8080', '2130706433:8080', '0x7f:8080', 'host:8080/mcp', 'user@host:8080', 'ok.example.com:8080,10.0.0.1:8080',
  ];

  test('a bad list throws UpstreamPolicyError', () => {
    for (const raw of BAD) {
      assert.throws(() => parseUpstreamPolicy(raw, OWN_NAMESPACE), UpstreamPolicyError, JSON.stringify(raw));
    }
  });

  test('an empty own namespace throws', () => {
    assert.throws(() => parseUpstreamPolicy(REAL_HOSTS[0], ''), UpstreamPolicyError);
  });

  test('the message never contains the raw input, whole or as an entry', () => {
    const full = 'secret-marker-9f3a.example.com:99999,woo-mcp.mcp-servers.svc.cluster.local:8080';
    assert.throws(() => parseUpstreamPolicy(full, OWN_NAMESPACE), (error: unknown) => {
      assert.ok(error instanceof UpstreamPolicyError);
      assert.ok(!error.message.includes(full));
      assert.ok(!error.message.includes('secret-marker-9f3a'));
      return true;
    });
    for (const raw of BAD) {
      try {
        parseUpstreamPolicy(raw, OWN_NAMESPACE);
        assert.fail(`should have thrown: ${JSON.stringify(raw)}`);
      } catch (error) {
        assert.ok(error instanceof UpstreamPolicyError);
        for (const part of raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length >= 4)) {
          assert.ok(!error.message.includes(part), `${JSON.stringify(part)} is in the message`);
        }
      }
    }
  });
});
