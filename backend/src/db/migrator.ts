import fs from 'node:fs';
import path from 'node:path';
import { pool, withTransaction } from '../config/db';
import { createLogger } from '../utils/logger';

const log = createLogger('migrator');

// Resolves to src/db/migrations in dev (tsx) and dist/db/migrations in prod,
// which is why the Dockerfile copies the .sql files next to the build output.
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationRow {
  name: string;
}

/**
 * Arbitrary but fixed key for `pg_advisory_lock`. The API and the worker both
 * migrate on boot and Docker starts them together, so without this they race
 * and one crashes on a duplicate `schema_migrations` insert.
 */
const MIGRATION_LOCK_KEY = 8_724_113;

/**
 * Minimal forward-only migrator: every .sql file runs once, in filename order,
 * inside its own transaction. Enough for this service and it keeps the schema
 * reviewable as plain SQL instead of ORM metadata.
 */
export async function runMigrations(): Promise<string[]> {
  // Session-level lock held on one dedicated connection for the whole run; a
  // second process blocks here and then finds nothing left to apply.
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await applyPendingMigrations();
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}

async function applyPendingMigrations(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<MigrationRow>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    });

    applied.push(file);
    log.info('Applied migration', { file });
  }

  if (applied.length === 0) log.info('Schema already up to date', { migrations: files.length });
  return applied;
}
