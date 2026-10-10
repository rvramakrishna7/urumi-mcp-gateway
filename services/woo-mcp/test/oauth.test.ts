import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizationHeader, percentEncode } from '../src/oauth.ts';
import type { OAuthInput } from '../src/oauth.ts';

const consumerKey = `ck_${'1'.repeat(40)}`;
const consumerSecret = `cs_${'2'.repeat(40)}`;
const publicUrl = 'http://store.urumi.test/wp-json/wc/v3';

// The expected signatures were computed by an independent implementation, not by the code under test:
// a Python script with hmac, hashlib, base64 and urllib.parse.quote(safe='-._~'), using the key and secret
// above, the nonces and timestamps below, and the same signature rules as WooCommerce
// (WC_REST_Authentication::check_oauth_signature).
interface Case {
  name: string;
  input: Omit<OAuthInput, 'consumerKey' | 'consumerSecret'>;
  signature: string;
}

const cases: Case[] = [
  {
    name: 'no query string',
    input: { method: 'GET', url: `${publicUrl}/products`, query: [], nonce: 'nonce-plain-0001', timestamp: 1700000000 },
    signature: 'zrfiDB8wfouWjRzrpydwAo0zlDfHBb1LzclgOalZhT0=',
  },
  {
    name: 'two query parameters',
    input: {
      method: 'GET',
      url: `${publicUrl}/orders`,
      query: [['per_page', '1'], ['status', 'processing']],
      nonce: 'nonce-query-0002',
      timestamp: 1700000001,
    },
    signature: 'H8ByQyDiTDEI6QjSioz1uSaeLrR0S7fCKNKlFjX7Mos=',
  },
  {
    name: 'a query value with spaces, reserved characters and non-ASCII',
    input: {
      method: 'GET',
      url: `${publicUrl}/products`,
      query: [['search', 'a b&c=d~eé+/'], ['per_page', '5']],
      nonce: 'nonce-special-03',
      timestamp: 1700000002,
    },
    signature: '+j1CM/XfGIunKFRCZ1TEfNMEgiw6pZAjQdRz7xphnB4=',
  },
  {
    name: 'a repeated parameter name, sorted by value',
    input: {
      method: 'GET',
      url: `${publicUrl}/orders`,
      query: [['include[]', '7'], ['include[]', '3'], ['a', 'z']],
      nonce: 'nonce-dupes-0004',
      timestamp: 1700000003,
    },
    signature: 'Capl8hcKEM9Ujh+hfkbFV/Hp0WZ3TMldrPeCHbmlP8c=',
  },
  {
    name: 'POST (the method is part of the signed text)',
    input: { method: 'POST', url: `${publicUrl}/products`, query: [], nonce: 'nonce-post-00005', timestamp: 1700000004 },
    signature: 'Mzt7TjlLc1IHWlHzfXMP26bKHbykrwFC8XCHZNP4vdU=',
  },
  {
    name: 'a public URL with a port',
    input: {
      method: 'GET',
      url: 'http://store.urumi.test:8080/wp-json/wc/v3/products',
      query: [['per_page', '2']],
      nonce: 'nonce-port-00006',
      timestamp: 1700000005,
    },
    signature: 'fPsi8gjMmr90iWnDLMNQSLWNvsiu3xg+n4BeOkottgs=',
  },
];

// Splits `OAuth name="value",...` into decoded name and value pairs.
function parseHeader(header: string): Map<string, string> {
  assert.ok(header.startsWith('OAuth '));
  const parsed = new Map<string, string>();
  for (const part of header.slice('OAuth '.length).split(',')) {
    const match = /^([a-z_]+)="([^"]*)"$/.exec(part);
    assert.ok(match, `unexpected header part: ${part}`);
    parsed.set(match[1]!, decodeURIComponent(match[2]!));
  }
  return parsed;
}

describe('buildAuthorizationHeader', () => {
  for (const { name, input, signature } of cases) {
    test(`matches the independent signature: ${name}`, () => {
      const header = parseHeader(buildAuthorizationHeader({ ...input, consumerKey, consumerSecret }));
      assert.equal(header.get('oauth_signature'), signature);
    });
  }

  test('carries the oauth parameters in the header and never the secret', () => {
    const raw = buildAuthorizationHeader({ ...cases[0]!.input, consumerKey, consumerSecret });
    const header = parseHeader(raw);
    assert.deepEqual([...header.keys()].sort(), [
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_version',
    ]);
    assert.equal(header.get('oauth_consumer_key'), consumerKey);
    assert.equal(header.get('oauth_signature_method'), 'HMAC-SHA256');
    assert.equal(header.get('oauth_timestamp'), '1700000000');
    assert.ok(!raw.includes(consumerSecret));
  });

  test('does not put the query parameters into the header', () => {
    const raw = buildAuthorizationHeader({ ...cases[1]!.input, consumerKey, consumerSecret });
    assert.ok(!raw.includes('per_page'));
    assert.ok(!raw.includes('processing'));
  });

  test('uses a fresh random nonce and the current time by default', () => {
    const input = { method: 'GET', url: `${publicUrl}/products`, query: [], consumerKey, consumerSecret };
    const first = parseHeader(buildAuthorizationHeader(input));
    const second = parseHeader(buildAuthorizationHeader(input));
    assert.match(first.get('oauth_nonce')!, /^[0-9a-f]{32}$/);
    assert.notEqual(first.get('oauth_nonce'), second.get('oauth_nonce'));
    assert.ok(Math.abs(Number(first.get('oauth_timestamp')) - Date.now() / 1000) < 5);
  });

  test('a different secret, method or URL gives a different signature', () => {
    const base = { ...cases[0]!.input, consumerKey, consumerSecret };
    const signatureOf = (input: OAuthInput) => parseHeader(buildAuthorizationHeader(input)).get('oauth_signature');
    const expected = signatureOf(base);
    assert.notEqual(signatureOf({ ...base, consumerSecret: `cs_${'3'.repeat(40)}` }), expected);
    assert.notEqual(signatureOf({ ...base, method: 'POST' }), expected);
    assert.notEqual(signatureOf({ ...base, url: `${publicUrl}/orders` }), expected);
  });
});

describe('percentEncode', () => {
  test('keeps the RFC 3986 unreserved characters and encodes the rest', () => {
    assert.equal(percentEncode('AZaz09-._~'), 'AZaz09-._~');
    assert.equal(percentEncode("a b!'()*&=+/?é"), 'a%20b%21%27%28%29%2A%26%3D%2B%2F%3F%C3%A9');
  });
});
