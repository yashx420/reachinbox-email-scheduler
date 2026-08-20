import { closePool } from '../config/db';
import { runMigrations } from '../db/migrator';
import { ensureSenders, listSenders } from '../services/sender.service';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('scripts:senders');

/**
 * Provisions the SMTP pool. Ethereal accounts are throwaway inboxes that
 * accept every message and never deliver it — the printed credentials let you
 * log in at https://ethereal.email/login and read what was "sent".
 */
async function main(): Promise<void> {
  await runMigrations();
  await ensureSenders();

  const senders = await listSenders();
  log.info('Sender pool', { count: senders.length });

  // eslint-disable-next-line no-console
  console.log('\nSMTP senders (log in at https://ethereal.email/login to read the mail):\n');
  for (const sender of senders) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `  ${sender.label}`,
        `    host     ${sender.host}:${sender.port}`,
        `    user     ${sender.username}`,
        `    pass     ${sender.password}`,
        `    active   ${sender.is_active}`,
      ].join('\n'),
    );
  }
  // eslint-disable-next-line no-console
  console.log('');
}

main()
  .catch((err) => {
    log.error('Failed to create senders', { error: describeError(err) });
    process.exitCode = 1;
  })
  .finally(() => closePool());
