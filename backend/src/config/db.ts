import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('db');

// node-postgres returns BIGINT/COUNT as a string to avoid precision loss. Our
// counters never approach 2^53, so surfacing them as numbers keeps the API
// response types honest (`{ total: 42 }`, not `{ total: "42" }`).
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.databasePoolMax,
  // Fail fast instead of hanging a request when Postgres is down.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => log.error('Idle client error', { error: describeError(err) }));

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function assertDatabaseReachable(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}
