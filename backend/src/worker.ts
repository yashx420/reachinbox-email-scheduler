import { env } from './config/env';
import { closePool } from './config/db';
import { closeRedis } from './config/redis';
import { closeQueue } from './queue/queues';
import { reconcilePendingJobs } from './queue/reconciler';
import { createEmailWorker } from './queue/worker';
import { closeAllTransports } from './services/mailer.service';
import { installShutdownHooks, waitForDependencies } from './bootstrap';
import { createLogger, describeError } from './utils/logger';

const log = createLogger('worker-process');

/**
 * Standalone worker. Run as many of these as you like — the Redis-backed
 * limiter and hourly counters are shared, so throughput stays within the
 * configured limits no matter how many processes are running.
 */
async function main(): Promise<void> {
  await waitForDependencies();

  if (env.delivery.reconcileOnBoot) {
    await reconcilePendingJobs();
  }

  const worker = createEmailWorker();

  installShutdownHooks([
    { name: 'worker', close: () => worker.close() },
    { name: 'queue', close: closeQueue },
    { name: 'smtp', close: closeAllTransports },
    { name: 'redis', close: closeRedis },
    { name: 'postgres', close: closePool },
  ]);
}

main().catch((err) => {
  log.error('Failed to start worker', { error: describeError(err) });
  process.exit(1);
});
