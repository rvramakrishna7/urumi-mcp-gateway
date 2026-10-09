import { McpServer } from '@modelcontextprotocol/server';

export const SERVER_NAME = 'woo-mcp';
export const SERVER_VERSION = '0.1.0';

// A new McpServer is created for every request (stateless Streamable HTTP). The tools capability is declared
// explicitly so that tools/list answers with a list instead of "method not found" while the list is still empty.
// The list is static, so listChanged is false.
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
}
