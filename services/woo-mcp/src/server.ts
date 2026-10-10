import { McpServer } from '@modelcontextprotocol/server';
import type { Logger } from './logger.ts';
import { registerTool } from './tools/common.ts';
import type { ToolDeps } from './tools/common.ts';
import { tools } from './tools/index.ts';

export const SERVER_NAME = 'woo-mcp';
export const SERVER_VERSION = '0.1.1';

// A new McpServer is created for every request (stateless Streamable HTTP). The tools capability is declared
// explicitly. The list is static, so listChanged is false.
export function createMcpServer(deps: ToolDeps, logger: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const tool of tools) {
    registerTool(server, tool, deps, logger);
  }
  return server;
}
