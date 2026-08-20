import { assertDatabaseReachable } from './config/db';
import { assertRedisReachable } from './config/redis';
import { createLogger, describeError } from './utils/logger';

const log = createLogger('bootstrap');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Docker starts Postgres/Redis and the API at the same time, so a cold boot
 * routinely races the datastores. Retry briefly instead of crash-looping.
 */
export async function waitForDependencies(attempts = 15, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await Promise.all([assertDatabaseReachable(), assertRedisReachable()]);
      log.info('Datastores reachable');
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(`Datastores unreachable after ${attempts} attempts: ${describeError(err)}`);
      }
      log.warn('Waiting for datastores', { attempt, error: describeError(err) });
      await sleep(delayMs);
    }
  }
}

type Closer = () => Promise<unknown> | unknown;

/**
 * Drains in-flight work before exiting: the worker finishes the emails it has
 * already started, then connections close. Without this, SIGTERM during a send
 * would leave a row stuck in `processing` until the reconciler releases it.
 */
export function installShutdownHooks(closers: { name: string; close: Closer }[]): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });

    for (const { name, close } of closers) {
      try {
        await close();
        log.debug('Closed', { resource: name });
      } catch (err) {
        log.warn('Failed to close cleanly', { resource: name, error: describeError(err) });
      }
    }

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { error: describeError(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: describeError(err) });
    void shutdown('uncaughtException');
  });
}
