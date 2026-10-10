import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildAuthorizationHeader } from '../src/oauth.ts';
import { MAX_BODY_BYTES, WooApiError, WooClient } from '../src/wooClient.ts';

const consumerKey = `ck_${'a'.repeat(40)}`;
const consumerSecret = `cs_${'b'.repeat(40)}`;
const publicUrl = 'http://store.urumi.test';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

// A real HTTP server on a free local port. The handler decides the answer, and every request is recorded.
async function startServer(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(seen);
      handler(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, requests, port, baseUrl: `http://127.0.0.1:${port}` };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Splits the Authorization header into its decoded oauth parameters.
function parseOAuth(header: string | undefined): Map<string, string> {
  if (header === undefined || !header.startsWith('OAuth ')) {
    assert.fail('Authorization header with the OAuth scheme expected');
  }
  return new Map(
    header.slice('OAuth '.length).split(',').map((part) => {
      const match = /^([a-z_]+)="([^"]*)"$/.exec(part);
      assert.ok(match);
      return [match[1]!, decodeURIComponent(match[2]!)] as const;
    }),
  );
}

describe('WooClient', () => {
  const servers: Server[] = [];
  const track = async (handler: Parameters<typeof startServer>[0]) => {
    const started = await startServer(handler);
    servers.push(started.server);
    return started;
  };
  const clientFor = (baseUrl: string, timeoutMs = 2000) =>
    new WooClient({ baseUrl, publicUrl, consumerKey, consumerSecret, timeoutMs });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });

  test('signs for the public URL, sends to the base URL and keeps oauth parameters out of the URL', async () => {
    const { requests, baseUrl, port } = await track((_req, res) => json(res, 200, [{ id: 1 }]));
    const result = await clientFor(baseUrl).request('GET', {
      path: '/wp-json/wc/v3/orders',
      query: [['per_page', '1'], ['search', 'a b&c']],
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.data, [{ id: 1 }]);
    assert.equal(requests.length, 1);
    const seen = requests[0]!;
    assert.equal(seen.method, 'GET');
    // Only the real query parameters are in the request line, which the Apache access log records.
    assert.equal(seen.url, '/wp-json/wc/v3/orders?per_page=1&search=a%20b%26c');
    assert.ok(!seen.url.includes('oauth_'));
    assert.equal(seen.headers.host, `127.0.0.1:${port}`);
    assert.equal(seen.headers.accept, 'application/json');

    const oauth = parseOAuth(seen.headers.authorization);
    assert.equal(oauth.get('oauth_consumer_key'), consumerKey);
    // Recompute the signature from the nonce and time that were sent. It matches only when it was
    // computed for the public URL and the same query.
    const sameInput = {
      method: 'GET',
      query: [['per_page', '1'], ['search', 'a b&c']] as const,
      consumerKey,
      consumerSecret,
      nonce: oauth.get('oauth_nonce'),
      timestamp: Number(oauth.get('oauth_timestamp')),
    };
    const expectedFor = (url: string) => parseOAuth(buildAuthorizationHeader({ ...sameInput, url })).get('oauth_signature');
    assert.equal(oauth.get('oauth_signature'), expectedFor(`${publicUrl}/wp-json/wc/v3/orders`));
    assert.notEqual(oauth.get('oauth_signature'), expectedFor(`${baseUrl}/wp-json/wc/v3/orders`));

    const everything = JSON.stringify([seen.url, seen.headers, seen.body]);
    assert.ok(!everything.includes(consumerSecret));
  });

  test('sends a JSON body with a content type and signs the POST method', async () => {
    const { requests, baseUrl } = await track((_req, res) => json(res, 201, { id: 7 }));
    const result = await clientFor(baseUrl).request('POST', { path: '/wp-json/wc/v3/products', body: { name: 'Mug', regular_price: '9.99' } });

    assert.equal(result.status, 201);
    assert.deepEqual(result.data, { id: 7 });
    const seen = requests[0]!;
    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen.body), { name: 'Mug', regular_price: '9.99' });
    const oauth = parseOAuth(seen.headers.authorization);
    const post = buildAuthorizationHeader({
      method: 'POST',
      url: `${publicUrl}/wp-json/wc/v3/products`,
      query: [],
      consumerKey,
      consumerSecret,
      nonce: oauth.get('oauth_nonce'),
      timestamp: Number(oauth.get('oauth_timestamp')),
    });
    assert.equal(oauth.get('oauth_signature'), parseOAuth(post).get('oauth_signature'));
  });

  test('uses a new nonce for every request', async () => {
    const { requests, baseUrl } = await track((_req, res) => json(res, 200, {}));
    const client = clientFor(baseUrl);
    await client.request('GET', { path: '/a' });
    await client.request('GET', { path: '/a' });
    const nonces = requests.map((seen) => parseOAuth(seen.headers.authorization).get('oauth_nonce'));
    assert.notEqual(nonces[0], nonces[1]);
  });

  test('returns null data for an empty body', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(204).end();
    });
    assert.deepEqual(await clientFor(baseUrl).request('GET', { path: '/a' }), { status: 204, data: null });
  });

  test('reports a WooCommerce error with its status and code', async () => {
    const { baseUrl } = await track((_req, res) =>
      json(res, 401, { code: 'woocommerce_rest_authentication_error', message: 'Consumer key is invalid.', data: { status: 401 } }),
    );
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 401);
      assert.equal(error.code, 'woocommerce_rest_authentication_error');
      assert.equal(error.message, 'WooCommerce answered with status 401 (woocommerce_rest_authentication_error: Consumer key is invalid.)');
      return true;
    });
  });

  test('removes the key and the secret if WooCommerce echoes them in an error', async () => {
    const { baseUrl } = await track((_req, res) =>
      json(res, 400, { code: 'bad_request', message: `bad key ${consumerKey} and secret ${consumerSecret}\nnext line` }),
    );
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.ok(!error.message.includes(consumerKey) && !error.message.includes(consumerSecret));
      assert.match(error.message, /bad key \[redacted\] and secret \[redacted\] next line/);
      return true;
    });
  });

  test('limits the length of a WooCommerce message', async () => {
    const { baseUrl } = await track((_req, res) => json(res, 500, { code: 'x', message: 'y'.repeat(5000) }));
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.ok(error.message.length < 300);
      return true;
    });
  });

  test('reports only the status when the error body is not JSON', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' }).end(`<html>${consumerSecret}</html>`);
    });
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 502);
      assert.equal(error.code, undefined);
      assert.equal(error.message, 'WooCommerce answered with status 502');
      return true;
    });
  });

  test('does not follow a redirect and never sends the request on', async () => {
    const target = await track((_req, res) => json(res, 200, { reached: true }));
    const redirecting = await track((_req, res) => {
      res.writeHead(302, { Location: `${target.baseUrl}/elsewhere` }).end();
    });
    await assert.rejects(clientFor(redirecting.baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'redirect');
      assert.equal(error.status, 302);
      assert.ok(!error.message.includes(target.baseUrl));
      return true;
    });
    assert.equal(redirecting.requests.length, 1);
    assert.equal(target.requests.length, 0);
  });

  test('times out when the server never answers', async () => {
    const { baseUrl } = await track(() => {
      // No answer.
    });
    const start = Date.now();
    await assert.rejects(clientFor(baseUrl, 200).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.message, 'WooCommerce did not answer within 200 ms');
      return true;
    });
    assert.ok(Date.now() - start < 1500);
  });

  test('times out when the headers arrive but the body never finishes', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
    });
    await assert.rejects(clientFor(baseUrl, 200).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'timeout');
      return true;
    });
  });

  test('reports a network error with the system code and without the address', async () => {
    const { server, baseUrl } = await startServer((_req, res) => json(res, 200, {}));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'network');
      assert.equal(error.message, 'could not reach WooCommerce (ECONNREFUSED)');
      assert.ok(!error.message.includes('127.0.0.1'));
      return true;
    });
  });

  test('accepts a body of exactly 2 MB', async () => {
    const filler = 'x'.repeat(MAX_BODY_BYTES - 2);
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(filler));
    });
    const result = await clientFor(baseUrl, 10_000).request<string>('GET', { path: '/a' });
    assert.equal(result.data.length, MAX_BODY_BYTES - 2);
  });

  test('refuses a body larger than 2 MB when the length is declared', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify('x'.repeat(MAX_BODY_BYTES)));
    });
    await assert.rejects(clientFor(baseUrl, 10_000).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'invalid-response');
      assert.equal(error.message, 'WooCommerce answered with status 200 and a body larger than 2 MB');
      return true;
    });
  });

  test('refuses a body larger than 2 MB when no length is declared', async () => {
    const { baseUrl } = await track((_req, res) => {
      // Chunked: there is no Content-Length, so the client has to count the bytes.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('["');
      for (let sent = 0; sent <= MAX_BODY_BYTES; sent += 65_536) res.write('x'.repeat(65_536));
      res.end('"]');
    });
    await assert.rejects(clientFor(baseUrl, 10_000).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'invalid-response');
      return true;
    });
  });

  test('reports the status of an error answer whose body is larger than 2 MB', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' }).end('x'.repeat(MAX_BODY_BYTES + 1));
    });
    await assert.rejects(clientFor(baseUrl, 10_000).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 500);
      assert.equal(error.message, 'WooCommerce answered with status 500');
      return true;
    });
  });

  test('reports a 200 answer that is not JSON', async () => {
    const { baseUrl } = await track((_req, res) => {
      res.writeHead(200).end('<html>not json</html>');
    });
    await assert.rejects(clientFor(baseUrl).request('GET', { path: '/a' }), (error: unknown) => {
      assert.ok(error instanceof WooApiError);
      assert.equal(error.kind, 'invalid-response');
      assert.equal(error.status, 200);
      return true;
    });
  });

  test('rejects a path with a query string, a fragment or no leading slash before any request is sent', async () => {
    const { requests, baseUrl } = await track((_req, res) => json(res, 200, {}));
    const client = clientFor(baseUrl);
    for (const path of ['/a?b=1', '/a#b', 'a']) {
      await assert.rejects(client.request('GET', { path }), TypeError, path);
    }
    assert.equal(requests.length, 0);
  });
});
