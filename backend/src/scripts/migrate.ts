import { closePool } from '../config/db';
import { runMigrations } from '../db/migrator';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('scripts:migrate');

async function main(): Promise<void> {
  const applied = await runMigrations();
  log.info('Migrations complete', { applied: applied.length });
}

main()
  .catch((err) => {
    log.error('Migration failed', { error: describeError(err) });
    process.exitCode = 1;
  })
  .finally(() => closePool());
