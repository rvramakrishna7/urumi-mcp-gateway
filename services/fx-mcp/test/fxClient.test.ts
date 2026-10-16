import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FxApiError, FxClient, MAX_BODY_BYTES } from '../src/fxClient.ts';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

// A real HTTP server on a free local port. The handler decides the answer, and every request is recorded.
async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, requests, baseUrl: `http://127.0.0.1:${port}` };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function failure(promise: Promise<unknown>): Promise<FxApiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof FxApiError, `expected FxApiError, got ${String(error)}`);
  return error;
}

describe('FxClient', () => {
  const servers: Server[] = [];
  const track = async (handler: Parameters<typeof startServer>[0], timeoutMs = 2000) => {
    const started = await startServer(handler);
    servers.push(started.server);
    return { ...started, client: new FxClient({ baseUrl: started.baseUrl, timeoutMs }) };
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  });

  describe('getRate', () => {
    test('asks /v2/rate/<base>/<quote> with GET and returns the checked answer', async () => {
      const { client, requests } = await track((_req, res) => json(res, 200, { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: 106.45 }));
      assert.deepEqual(await client.getRate('EUR', 'INR'), { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: 106.45 });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, 'GET');
      assert.equal(requests[0]?.url, '/v2/rate/EUR/INR');
      assert.equal(requests[0]?.headers.authorization, undefined, 'no credential is sent to the rate service');
    });

    test('adds the date as a query parameter', async () => {
      const { client, requests } = await track((_req, res) => json(res, 200, { date: '2026-10-01', base: 'INR', quote: 'EUR', rate: 0.0092 }));
      await client.getRate('INR', 'EUR', '2026-10-01');
      assert.equal(requests[0]?.url, '/v2/rate/INR/EUR?date=2026-10-01');
    });

    test('refuses a code or a date that is not plain before any request is sent', async () => {
      const { client, requests } = await track((_req, res) => json(res, 200, {}));
      for (const [base, quote, date] of [
        ['eur', 'INR', undefined],
        ['EU', 'INR', undefined],
        ['EUR/..', 'INR', undefined],
        ['EUR', 'IN?R', undefined],
        ['EUR', 'INR', '2026-10-1'],
        ['EUR', 'INR', '2026-10-01&x=1'],
        ['EUR', 'INR', '../x'],
      ] as const) {
        await assert.rejects(client.getRate(base, quote, date), TypeError, `${base} ${quote} ${date}`);
      }
      assert.equal(requests.length, 0);
    });

    test('an answer of the wrong shape is invalid-response', async () => {
      const wrong: unknown[] = [
        null,
        [],
        'x',
        {},
        { date: '2026-10-16', base: 'EUR', quote: 'INR' },
        { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: '106.45' },
        { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: 0 },
        { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: -2 },
        { date: '16-10-2026', base: 'EUR', quote: 'INR', rate: 106.45 },
        { date: '2026-10-16', base: 'USD', quote: 'INR', rate: 106.45 },
        { date: '2026-10-16', base: 'EUR', quote: 'GBP', rate: 106.45 },
      ];
      for (const body of wrong) {
        const { client } = await track((_req, res) => json(res, 200, body));
        const error = await failure(client.getRate('EUR', 'INR'));
        assert.equal(error.kind, 'invalid-response', JSON.stringify(body));
      }
    });

    test('maps the statuses: 404, 422, 429, 500 and an HTML error page', async () => {
      const cases: Array<[number, string, (res: ServerResponse) => void]> = [
        [404, 'not-found', (res) => json(res, 404, { status: 404, message: 'not found' })],
        [422, 'http', (res) => json(res, 422, { status: 422, message: 'invalid currency: ABC' })],
        [429, 'rate-limited', (res) => json(res, 429, { message: 'slow down' })],
        [500, 'http', (res) => { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<html>boom</html>'); }],
      ];
      for (const [status, kind, respond] of cases) {
        const { client } = await track((_req, res) => respond(res));
        const error = await failure(client.getRate('EUR', 'INR'));
        assert.equal(error.kind, kind, String(status));
        assert.equal(error.status, status);
      }
    });

    test('does not follow a redirect', async () => {
      const target = await track((_req, res) => json(res, 200, { date: '2026-10-16', base: 'EUR', quote: 'INR', rate: 1 }));
      const { client } = await track((_req, res) => { res.writeHead(302, { Location: `${target.baseUrl}/v2/rate/EUR/INR` }); res.end(); });
      const error = await failure(client.getRate('EUR', 'INR'));
      assert.equal(error.kind, 'redirect');
      assert.equal(target.requests.length, 0, 'the redirect target was never called');
    });

    test('times out when the service is too slow', async () => {
      const { client } = await track(() => { /* never answers */ }, 150);
      assert.equal((await failure(client.getRate('EUR', 'INR'))).kind, 'timeout');
    });

    test('a refused connection is a network error and the message holds no address', async () => {
      const probe = await startServer((_req, res) => res.end());
      await new Promise<void>((resolve) => probe.server.close(() => resolve()));
      const error = await failure(new FxClient({ baseUrl: probe.baseUrl, timeoutMs: 1000 }).getRate('EUR', 'INR'));
      assert.equal(error.kind, 'network');
      assert.match(error.message, /ECONNREFUSED/);
      assert.doesNotMatch(error.message, /127\.0\.0\.1|http/);
    });

    test('refuses a body larger than the limit, declared or not', async () => {
      const big = 'x'.repeat(MAX_BODY_BYTES + 10);
      const declared = await track((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(big); });
      assert.equal((await failure(declared.client.getRate('EUR', 'INR'))).kind, 'invalid-response');
      const chunked = await track((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(big.slice(0, MAX_BODY_BYTES / 2)); res.write(big.slice(0, MAX_BODY_BYTES / 2)); res.end('yy'); });
      assert.equal((await failure(chunked.client.getRate('EUR', 'INR'))).kind, 'invalid-response');
    });

    test('a body that is not JSON is invalid-response', async () => {
      const { client } = await track((_req, res) => { res.writeHead(200); res.end('not json'); });
      assert.equal((await failure(client.getRate('EUR', 'INR'))).kind, 'invalid-response');
    });

    test('no message carries a URL, a body or an echoed secret', async () => {
      const { client } = await track((_req, res) => json(res, 500, { message: 'secret-token-abc at http://internal.example/x' }));
      const error = await failure(client.getRate('EUR', 'INR'));
      assert.doesNotMatch(error.message, /secret-token-abc|internal\.example|http/);
    });
  });

  describe('listCurrencies', () => {
    test('returns the code and the cleaned name of every currency', async () => {
      const { client, requests } = await track((_req, res) =>
        json(res, 200, [
          { iso_code: 'EUR', name: 'Euro', symbol: 'E', iso_numeric: '978' },
          { iso_code: 'INR', name: `Indian${String.fromCharCode(0x200b)} Rupee\n${String.fromCharCode(0x202e)}`, symbol: 'R' },
        ]),
      );
      assert.deepEqual(await client.listCurrencies(), [
        { code: 'EUR', name: 'Euro' },
        { code: 'INR', name: 'Indian Rupee' },
      ]);
      assert.equal(requests[0]?.url, '/v2/currencies');
    });

    test('cuts a very long name', async () => {
      const { client } = await track((_req, res) => json(res, 200, [{ iso_code: 'EUR', name: 'N'.repeat(500) }]));
      const [first] = await client.listCurrencies();
      assert.ok((first?.name.length ?? 0) <= 83);
    });

    test('an answer of the wrong shape is invalid-response', async () => {
      for (const body of [{}, 'x', [null], [{ iso_code: 'euro', name: 'x' }], [{ iso_code: 'EUR' }], [{ iso_code: 'EUR', name: 5 }]]) {
        const { client } = await track((_req, res) => json(res, 200, body));
        assert.equal((await failure(client.listCurrencies())).kind, 'invalid-response', JSON.stringify(body));
      }
    });
  });
});
