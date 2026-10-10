import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

// A small fake MCP server over plain node:http (stateless Streamable HTTP, JSON responses). It is raw on purpose: the
// SDK server refuses to send what these tests need to send (a tool name with a space, a 3 MB answer, a redirect).
// The client under test is the real SDK client. The fake records what it received, so a test can prove that an
// upstream got no request.

export interface FakeTool {
  name: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface FakeOptions {
  tools?: FakeTool[];
  // When set, a request without "Authorization: Bearer <token>" gets 401.
  token?: string;
  initializeDelayMs?: number;
  listDelayMs?: number;
  // Per tool: how long tools/call waits before it answers.
  callDelayMs?: Record<string, number>;
  // Tools that answer with isError: true.
  failingTools?: string[];
  // Tools that answer with a body of this many bytes.
  hugeTools?: Record<string, number>;
  // When set, every POST is answered with a redirect to this URL.
  redirectTo?: string;
  // The text of every tool result, so a test can find it again.
  resultText?: (tool: string, args: unknown) => string;
}

export interface RecordedRequest {
  method: string;
  rpc: string | null;
  tool: string | null;
  authorization: string | null;
  // Every request header, lower case.
  headers: Record<string, string | string[] | undefined>;
}

export interface Fake {
  url: string;
  port: number;
  requests: RecordedRequest[];
  toolCalls: () => number;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  options: FakeOptions;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startFake(options: FakeOptions = {}, port = 0): Promise<Fake> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let server: Server;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : null;
    if (request.method !== 'POST') {
      requests.push({ method: request.method ?? '', rpc: null, tool: null, authorization, headers: request.headers });
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const rpc = JSON.parse((await readBody(request)) || '{}') as { id?: number; method?: string; params?: any };
    requests.push({ method: 'POST', rpc: rpc.method ?? null, tool: rpc.method === 'tools/call' ? String(rpc.params?.name) : null, authorization, headers: request.headers });

    if (options.redirectTo) {
      response.writeHead(307, { location: options.redirectTo }).end();
      return;
    }
    if (options.token && authorization !== `Bearer ${options.token}`) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    switch (rpc.method) {
      case 'initialize':
        if (options.initializeDelayMs) await delay(options.initializeDelayMs);
        json(response, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
        });
        return;
      case 'notifications/initialized':
        response.writeHead(202).end();
        return;
      case 'tools/list':
        if (options.listDelayMs) await delay(options.listDelayMs);
        json(response, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: options.tools ?? [] } });
        return;
      case 'tools/call': {
        const name = String(rpc.params?.name);
        const wait = options.callDelayMs?.[name];
        if (wait) await delay(wait);
        const huge = options.hugeTools?.[name];
        const text = huge ? 'x'.repeat(huge) : (options.resultText?.(name, rpc.params?.arguments) ?? `${name} done ${JSON.stringify(rpc.params?.arguments ?? {})}`);
        json(response, 200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }], ...(options.failingTools?.includes(name) ? { isError: true } : {}) } });
        return;
      }
      default:
        json(response, 200, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
    }
  };

  const fake: Fake = {
    url: '',
    port: 0,
    requests,
    toolCalls: () => requests.filter((entry) => entry.rpc === 'tools/call').length,
    options,
    start: () =>
      new Promise<void>((resolve) => {
        server = createServer((request, response) => {
          handler(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
          });
        });
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        server.listen(fake.port || port, '127.0.0.1', () => {
          fake.port = (server.address() as { port: number }).port;
          fake.url = `http://127.0.0.1:${fake.port}/mcp`;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  await fake.start();
  return fake;
}
