import { createApp } from './app';
import { env } from './config/env';
import { closePool } from './config/db';
import { closeRedis } from './config/redis';
import { runMigrations } from './db/migrator';
import { closeQueue } from './queue/queues';
import { reconcilePendingJobs } from './queue/reconciler';
import { createEmailWorker } from './queue/worker';
import { ensureSenders } from './services/sender.service';
import { closeAllTransports } from './services/mailer.service';
import { installShutdownHooks, waitForDependencies } from './bootstrap';
import { createLogger, describeError } from './utils/logger';

const log = createLogger('server');

async function main(): Promise<void> {
  await waitForDependencies();
  await runMigrations();

  // Provisions Ethereal mailboxes the first time the service ever runs, so a
  // fresh clone can schedule mail without any manual SMTP setup.
  try {
    const senders = await ensureSenders();
    log.info('Sender pool ready', { senders: senders.length });
  } catch (err) {
    log.warn('Could not provision senders automatically', { error: describeError(err) });
  }

  // Restart safety: re-add anything the queue lost and release jobs that were
  // mid-flight when the previous process died. Runs before we accept traffic.
  if (env.delivery.reconcileOnBoot) {
    await reconcilePendingJobs();
  }

  const worker = env.worker.runInline ? createEmailWorker() : null;
  if (!worker) log.info('Inline worker disabled — run `npm run dev:worker` in a second terminal');

  const app = createApp();
  const server = app.listen(env.port, () => {
    log.info('API listening', { port: env.port, env: env.nodeEnv, url: `http://localhost:${env.port}` });
  });

  installShutdownHooks([
    { name: 'http', close: () => new Promise((resolve) => server.close(resolve)) },
    { name: 'worker', close: () => worker?.close() },
    { name: 'queue', close: closeQueue },
    { name: 'smtp', close: closeAllTransports },
    { name: 'redis', close: closeRedis },
    { name: 'postgres', close: closePool },
  ]);
}

main().catch((err) => {
  log.error('Failed to start API', { error: describeError(err) });
  process.exit(1);
});
