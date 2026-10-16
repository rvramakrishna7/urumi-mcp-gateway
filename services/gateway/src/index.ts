import { createApp } from './app.ts';
import { ConfigError, loadChatConfig, loadConfig, loadSecurityConfig } from './config.ts';
import type { ChatConfig, Config, SecurityConfig } from './config.ts';
import { CryptoError, loadKeyring } from './crypto/credentials.ts';
import type { Keyring } from './crypto/credentials.ts';
import { checkDatabase, createPool } from './db/pool.ts';
import { createLogger } from './logger.ts';
import { createGateway } from './core/gateway.ts';
import { applySeed, loadSeedFile, SeedError } from './registry/seed.ts';
import { createMcpRouter } from './mcp/router.ts';
import { sessionAuthConfig } from './auth/session.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createMeKeysRouter } from './routes/me-keys.ts';
import { createAuditRouter } from './routes/audit.ts';
import { createChatRouter } from './routes/chat.ts';
import { createAgent } from './chat/agent.ts';
import { createGroqClient } from './chat/groq.ts';
import { applyBootstrap, BootstrapError, readBootstrapToken } from './identity/invites.ts';
import { createPoller } from './upstream/poller.ts';

const logger = createLogger();

let config: Config;
let security: SecurityConfig;
let chatConfig: ChatConfig;
let keyring: Keyring;
try {
  config = loadConfig();
  security = loadSecurityConfig();
  chatConfig = loadChatConfig();
  // The master key must be exactly 32 bytes. A wrong or missing key stops the start with a clear reason.
  keyring = loadKeyring(security.masterKeyFile, security.masterKeyId);
} catch (error) {
  // These messages name the variable and never contain a value.
  const known = error instanceof ConfigError || error instanceof CryptoError;
  logger.error('startup failed', { reason: known ? error.message : 'unexpected error' });
  process.exit(1);
}

const pool = createPool(config.db, (error) => {
  logger.error('database connection error', { errorName: error.name });
});

// The seed runs before the server listens, so the registry is complete when the first request arrives. A seed that
// cannot be applied stops the start: it is a configuration error that an operator must see.
try {
  if (security.seedFile) await applySeed(pool, keyring, loadSeedFile(security.seedFile), logger);
} catch (error) {
  logger.error('startup failed', { reason: error instanceof SeedError ? error.message : 'the seed could not be applied', errorName: error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
}

// The first admin: created, or armed again, before the server listens. Like the seed, a failure stops the start.
try {
  if (security.bootstrap) {
    const action = await applyBootstrap(pool, security.bootstrap.adminEmail, readBootstrapToken(security.bootstrap.tokenFile));
    logger.info('bootstrap admin', { action });
  }
} catch (error) {
  logger.error('startup failed', { reason: error instanceof BootstrapError ? error.message : 'the bootstrap admin could not be applied', errorName: error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
}

const gateway = createGateway({ db: pool, keyring, logger });
const poller = createPoller({ db: pool, keyring, logger });

const mcp = createMcpRouter({ db: pool, gateway, logger, allowedHosts: security.allowedHosts });

const sessions = sessionAuthConfig(security.publicOrigin);

// Without a Groq key there is no agent, and POST /api/chat answers 503. Nothing else depends on it.
const agent = chatConfig.groqApiKey
  ? createAgent({
      gateway,
      groq: createGroqClient({ apiKey: chatConfig.groqApiKey, model: chatConfig.model }),
      keyring,
      logger,
      confirmTools: chatConfig.confirmTools,
    })
  : undefined;
logger.info('chat', { configured: agent !== undefined, model: chatConfig.model, confirmTools: chatConfig.confirmTools.length, ratePerMinute: chatConfig.ratePerMinute });

const { app, beginShutdown } = createApp({
  logger,
  checkDatabase: () => checkDatabase(pool),
  admin: { db: pool, keyring, logger, sessions, onServerChanged: () => poller.refreshNow() },
  mcp: mcp.router,
  auth: createAuthRouter({ db: pool, logger, sessions }),
  me: createMeKeysRouter({ db: pool, logger, sessions }),
  audit: createAuditRouter({ db: pool, logger, sessions }),
  chat: createChatRouter({ db: pool, logger, sessions, agent, ratePerMinute: chatConfig.ratePerMinute }),
});
const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port });
  poller.start();
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  beginShutdown();
  server.close(() => {
    // The poller stops first, so that no probe writes to a closed pool.
    mcp.close().finally(() => poller.stop().finally(() => pool.end().finally(() => process.exit(0))));
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
