import type { Database } from '../db/queryable.ts';
import { CryptoError } from '../crypto/credentials.ts';
import type { Keyring } from '../crypto/credentials.ts';
import type { Logger } from '../logger.ts';
import { listServers, readCredential } from '../registry/repository.ts';
import type { ServerView } from '../registry/repository.ts';
import { listUpstreamTools, UpstreamError } from './client.ts';
import type { UpstreamLimits, UpstreamTarget } from './client.ts';
import { DEFAULT_LIMITS } from './client.ts';
import { reviewTools } from './sanitize.ts';
import { markConnected, markUnreachable, replaceTools } from './tools-repository.ts';

// The poller refreshes the cached tool list and the status of every enabled upstream (docs/architecture.md,
// decision 28). Each upstream is probed in parallel with its own deadline, so one slow or dead server cannot delay
// another. A cycle ends, and the next one is scheduled after it, so cycles never overlap.

export interface ProbeReport {
  slug: string;
  status: 'connected' | 'unreachable';
  reason: string | null;
  tools: number;
  skipped: number;
}

export interface Poller {
  start(): void;
  stop(): Promise<void>;
  // Runs a cycle now (or joins the one that is running) and returns what it found.
  refreshNow(): Promise<ProbeReport[]>;
}

export interface PollerDeps {
  db: Database;
  keyring: Keyring;
  logger: Logger;
  intervalMs?: number;
  jitterMs?: number;
  limits?: UpstreamLimits;
}

// The short code that is stored as the reason and shown to admins.
export function reasonOf(error: UpstreamError): string {
  if (error.kind === 'unauthorized') return 'http_401';
  if (error.kind === 'forbidden') return 'http_403';
  return error.kind;
}

export function createPoller({ db, keyring, logger, intervalMs = 15_000, jitterMs = 2000, limits = DEFAULT_LIMITS }: PollerDeps): Poller {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<ProbeReport[]> | null = null;
  let stopped = true;

  async function probe(server: ServerView): Promise<ProbeReport> {
    try {
      const credential = await readCredential(db, keyring, server.id);
      const target: UpstreamTarget = { url: server.url, credential };
      const offered = await listUpstreamTools(target, limits);
      const review = reviewTools(server.slug, offered);
      await replaceTools(db, server.id, review);
      await markConnected(db, server.id, review.note);
      for (const tool of review.skipped) logger.warn('tool skipped', { server: server.slug, reason: tool.reason });
      return { slug: server.slug, status: 'connected', reason: review.note, tools: review.accepted.length, skipped: review.skipped.length };
    } catch (error) {
      // An UpstreamError carries two fixed words. Anything else (the database, the decryption) is reduced to its class.
      // A credential that cannot be decrypted (the master key does not match) is its own reason, so an admin can see why.
      const unreadable = error instanceof CryptoError;
      const reason = error instanceof UpstreamError ? reasonOf(error) : unreadable ? 'credential_unreadable' : 'internal_error';
      if (unreadable) logger.warn('stored credential is unreadable', { server: server.slug, reason });
      else if (!(error instanceof UpstreamError)) logger.error('probe failed', { server: server.slug, errorName: error instanceof Error ? error.name : 'unknown' });
      try {
        await markUnreachable(db, server.id, reason);
      } catch {
        logger.error('status update failed', { server: server.slug });
      }
      return { slug: server.slug, status: 'unreachable', reason, tools: 0, skipped: 0 };
    }
  }

  async function cycle(): Promise<ProbeReport[]> {
    const servers = (await listServers(db)).filter((server) => server.enabled);
    const settled = await Promise.allSettled(servers.map(probe));
    return settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
  }

  function refreshNow(): Promise<ProbeReport[]> {
    running ??= cycle()
      .catch((error) => {
        logger.error('poll cycle failed', { errorName: error instanceof Error ? error.name : 'unknown' });
        return [];
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      refreshNow().finally(() => schedule(intervalMs + Math.round((Math.random() * 2 - 1) * jitterMs)));
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    refreshNow,
  };
}
