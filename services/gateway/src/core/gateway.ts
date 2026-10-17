import { randomUUID } from 'node:crypto';
import type { Database } from '../db/queryable.ts';
import { CryptoError } from '../crypto/credentials.ts';
import type { Keyring } from '../crypto/credentials.ts';
import { DEFAULT_MEMBER_RESTRICTED_TOOLS } from '../config.ts';
import type { Logger } from '../logger.ts';
import { finishAudit, startAudit } from '../audit/repository.ts';
import type { AuditOutcome } from '../audit/repository.ts';
import { readCredential } from '../registry/repository.ts';
import { callUpstreamTool, DEFAULT_LIMITS, UpstreamError } from '../upstream/client.ts';
import type { UpstreamLimits } from '../upstream/client.ts';
import { reasonOf } from '../upstream/poller.ts';
import { markConnectedByCall, markUnreachable } from '../upstream/tools-repository.ts';

// The one internal interface to the upstream tools (docs/architecture.md, decision 1b). The public /mcp endpoint
// and the chat agent both call these two functions, so timeouts, isolation and audit apply to both.

// Who is calling. "via" is how: an MCP client or the chat agent.
export interface Caller {
  userId: string;
  email: string;
  // Read from the users table on every request by the authentication middleware.
  role: 'admin' | 'member';
  via: 'mcp' | 'chat';
}

export interface ListedTool {
  // <slug>__<tool> (decision 5).
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
}

// The shape of an MCP tool result. A failure of the gateway is a result with isError, never an exception.
export interface ToolResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Gateway {
  listTools(caller: Caller): Promise<ListedTool[]>;
  callTool(caller: Caller, exposedName: string, args: Record<string, unknown>): Promise<ToolResult>;
  // Records a call that was refused before it reached the gateway core (a name the chat agent did not offer). It writes a
  // complete audit row and answers with a result, and it never reads a credential and never contacts an upstream.
  rejectToolCall(caller: Caller, exposedName: string, reason: 'not_offered'): Promise<ToolResult>;
}

export interface GatewayDeps {
  db: Database;
  keyring: Keyring;
  logger: Logger;
  limits?: UpstreamLimits;
  // Exposed names that only an admin may list or call. Defaults to the built-in list, never to "none".
  memberRestrictedTools?: readonly string[];
}

const UNKNOWN_TOOL = 'Unknown tool';
const ADMIN_REQUIRED = 'This tool requires admin access';

function failure(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// A failure of the call is a failure to reach or log in to the server (it changes the status), or a failure of the
// tool call itself (it is only written on the audit row). A timeout or error of tools/call on a server that
// connected is the second kind: the server is fine, the tool is slow or broken.
function changesStatus(error: UpstreamError): boolean {
  if (error.kind === 'refused' || error.kind === 'unauthorized' || error.kind === 'forbidden') return true;
  return error.stage === 'connect';
}

function outcomeOf(error: UpstreamError): AuditOutcome {
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'refused' || error.kind === 'unreachable' || error.kind === 'unauthorized' || error.kind === 'forbidden') return 'unreachable';
  return 'error';
}

// The sentence that the caller sees. Fixed text and the slug only: never a URL, a credential or a body.
function messageOf(error: UpstreamError, slug: string, callTimeoutMs: number, limits: UpstreamLimits): string {
  switch (error.kind) {
    case 'timeout': {
      const ms = error.stage === 'connect' ? limits.connectTimeoutMs : callTimeoutMs;
      return `Server "${slug}" did not answer within ${Math.round(ms / 100) / 10} s.`;
    }
    case 'too_large':
      return `Server "${slug}" returned a response that is too large.`;
    case 'protocol_error':
      return error.stage === 'connect' ? `Server "${slug}" is unreachable.` : `Server "${slug}" returned an invalid response.`;
    default:
      return `Server "${slug}" is unreachable.`;
  }
}

interface Route {
  serverId: string;
  slug: string;
  url: string;
  callTimeoutMs: number;
  tool: string;
}

export function createGateway({ db, keyring, logger, limits = DEFAULT_LIMITS, memberRestrictedTools = DEFAULT_MEMBER_RESTRICTED_TOOLS }: GatewayDeps): Gateway {
  const restricted = new Set(memberRestrictedTools);

  // Anyone who is not an admin is restricted, so an unexpected role value fails closed.
  const isRestrictedFor = (caller: Caller, exposedName: string) => caller.role !== 'admin' && restricted.has(exposedName);

  // The list is read from the database only, so a slow or dead upstream cannot slow it. A server that is not
  // connected contributes no tools.
  async function listTools(caller: Caller): Promise<ListedTool[]> {
    const result = await db.query(
      `SELECT s.slug, t.name, t.description, t.input_schema, t.annotations
       FROM upstream_servers s JOIN upstream_tools t ON t.server_id = s.id
       WHERE s.enabled AND s.status = 'connected' AND t.skipped_reason IS NULL
       ORDER BY s.slug, t.name`,
    );
    const tools = result.rows.map((row) => ({
      name: `${row.slug}__${row.name}`,
      description: row.description,
      inputSchema: row.input_schema,
      annotations: row.annotations,
    }));
    return tools.filter((tool) => !isRestrictedFor(caller, tool.name));
  }

  // The server and the tool of an exposed name. Null for an unknown tool, a disabled server and a skipped tool alike,
  // so the caller cannot tell which it was. A server that is marked unreachable is still tried: its status may be old.
  async function resolve(exposedName: string): Promise<Route | null> {
    const separator = exposedName.indexOf('__');
    if (separator < 1) return null;
    const result = await db.query(
      `SELECT s.id, s.slug, s.url, s.call_timeout_ms, t.name
       FROM upstream_servers s JOIN upstream_tools t ON t.server_id = s.id
       WHERE s.slug = $1 AND t.name = $2 AND s.enabled AND t.skipped_reason IS NULL`,
      [exposedName.slice(0, separator), exposedName.slice(separator + 2)],
    );
    const row = result.rows[0];
    return row ? { serverId: row.id, slug: row.slug, url: row.url, callTimeoutMs: row.call_timeout_ms, tool: row.name } : null;
  }

  async function finish(auditId: number, outcome: AuditOutcome, errorKind: string | null, startedAt: bigint): Promise<void> {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    try {
      await finishAudit(db, auditId, outcome, errorKind, durationMs);
    } catch (error) {
      // The call has happened. The caller still gets the result, and the row stays "started" until a later sweep.
      logger.error('audit phase 2 failed', { auditId, outcome, errorName: error instanceof Error ? error.name : 'unknown' });
    }
  }

  // The start of every call and of every refusal: resolve the name and write the phase 1 row. A failure here is returned as
  // a result, and then nothing else happens.
  async function open(caller: Caller, exposedName: string): Promise<{ route: Route | null; auditId: number } | { failed: ToolResult }> {
    let route: Route | null;
    try {
      route = await resolve(exposedName);
    } catch (error) {
      logger.error('tool lookup failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      return { failed: failure('The gateway could not process the call.') };
    }

    // Phase 1. No row, no call.
    let auditId: number;
    try {
      auditId = await startAudit(db, {
        userId: caller.userId,
        userEmail: caller.email,
        serverId: route?.serverId ?? null,
        serverSlug: route?.slug ?? null,
        requestedName: exposedName,
        tool: route?.tool ?? null,
        via: caller.via,
        requestId: randomUUID(),
      });
    } catch (error) {
      logger.error('audit phase 1 failed, the call was not made', { errorName: error instanceof Error ? error.name : 'unknown' });
      return { failed: failure('The call was not made because it could not be recorded.') };
    }
    return { route, auditId };
  }

  async function rejectToolCall(caller: Caller, exposedName: string, reason: 'not_offered'): Promise<ToolResult> {
    const opened = await open(caller, exposedName);
    if ('failed' in opened) return opened.failed;
    const { route, auditId } = opened;
    const startedAt = process.hrtime.bigint();
    if (!route) {
      await finish(auditId, 'unknown_tool', null, startedAt);
      return failure(UNKNOWN_TOOL);
    }
    // The name is rebuilt from the resolved route, not taken from the request.
    const restrictedForCaller = isRestrictedFor(caller, `${route.slug}__${route.tool}`);
    await finish(auditId, 'denied', restrictedForCaller ? 'member_restricted' : reason, startedAt);
    return failure(restrictedForCaller ? ADMIN_REQUIRED : UNKNOWN_TOOL);
  }

  async function callTool(caller: Caller, exposedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Phase 1. No row, no call.
    const opened = await open(caller, exposedName);
    if ('failed' in opened) return opened.failed;
    const { route, auditId } = opened;
    const startedAt = process.hrtime.bigint();

    if (!route) {
      await finish(auditId, 'unknown_tool', null, startedAt);
      return failure(UNKNOWN_TOOL);
    }

    // Before any credential is read or any connection is made. The name is rebuilt from the resolved route.
    if (isRestrictedFor(caller, `${route.slug}__${route.tool}`)) {
      await finish(auditId, 'denied', 'member_restricted', startedAt);
      return failure(ADMIN_REQUIRED);
    }

    try {
      const credential = await readCredential(db, keyring, route.serverId);
      const result = await callUpstreamTool({ url: route.url, credential }, route.tool, args, route.callTimeoutMs, limits);
      await markConnectedByCall(db, route.serverId).catch(() => logger.warn('status update failed', { server: route.slug }));
      await finish(auditId, result.isError ? 'error' : 'ok', result.isError ? 'tool_error' : null, startedAt);
      return result;
    } catch (error) {
      if (error instanceof CryptoError) {
        // The master key does not match the stored credential. The server cannot be called until it is set again.
        logger.warn('stored credential is unreadable', { server: route.slug, reason: 'credential_unreadable' });
        await markUnreachable(db, route.serverId, 'credential_unreadable').catch(() => logger.warn('status update failed', { server: route.slug }));
        await finish(auditId, 'unreachable', 'credential_unreadable', startedAt);
        return failure(`Server "${route.slug}" is unreachable.`);
      }
      if (!(error instanceof UpstreamError)) {
        logger.error('call failed inside the gateway', { server: route.slug, errorName: error instanceof Error ? error.name : 'unknown' });
        await finish(auditId, 'error', 'gateway_error', startedAt);
        return failure('The gateway could not complete the call.');
      }
      if (changesStatus(error)) {
        await markUnreachable(db, route.serverId, reasonOf(error)).catch(() => logger.warn('status update failed', { server: route.slug }));
      }
      await finish(auditId, outcomeOf(error), `${error.stage}_${error.kind}`, startedAt);
      return failure(messageOf(error, route.slug, route.callTimeoutMs, limits));
    }
  }

  return { listTools, callTool, rejectToolCall };
}
