import { Server } from '@modelcontextprotocol/server';
import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import type { Caller, Gateway } from '../core/gateway.ts';

export const SERVER_NAME = 'urumi-mcp-gateway';
export const SERVER_VERSION = '0.4.0';

// The identity of the caller travels in AuthInfo.extra. The user's API key is never put in AuthInfo: the SDK would
// carry it into its own request context, and nothing below this point needs it.
export function authInfoFor(identity: { keyId: string; userId: string; email: string }): AuthInfo {
  return { token: '', clientId: identity.userId, scopes: [], extra: { userId: identity.userId, email: identity.email } };
}

function callerOf(authInfo: AuthInfo | undefined): Caller {
  const extra = authInfo?.extra;
  const userId = typeof extra?.userId === 'string' ? extra.userId : null;
  const email = typeof extra?.email === 'string' ? extra.email : null;
  // The router authenticates before it calls the handler. A missing identity here is a programming error, and the
  // request must fail instead of running as nobody.
  if (!userId || !email) throw new Error('no authenticated caller');
  return { userId, email, via: 'mcp' };
}

// A new low-level Server for every request (stateless). The tool list depends on the registry at that moment, so
// McpServer.registerTool is not used: tools/list and tools/call go straight to the core (decisions 1b and 32).
export function createMcpServerFactory(gateway: Gateway): (context: McpRequestContext) => Server {
  return (context) => {
    const caller = callerOf(context.authInfo);
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: { listChanged: false } } });

    server.setRequestHandler('tools/list', async () => {
      const tools = await gateway.listTools(caller);
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as { type: 'object' },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      };
    });

    server.setRequestHandler('tools/call', async (request) => {
      const args = request.params.arguments ?? {};
      const result = await gateway.callTool(caller, request.params.name, args);
      return server.projectCallToolResult(result as never, undefined);
    });

    return server;
  };
}
