import IORedis, { type Redis } from 'ioredis';
import { env } from './env';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('redis');

/**
 * BullMQ blocks on Redis commands (BRPOPLPUSH and friends), which is
 * incompatible with ioredis' default request retry limit — hence
 * `maxRetriesPerRequest: null`. Every connection we hand to BullMQ must use
 * this factory.
 */
export function createRedisConnection(role: string): Redis {
  const connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  connection.on('error', (err) => log.error(`Connection error (${role})`, { error: describeError(err) }));
  connection.on('reconnecting', () => log.warn(`Reconnecting (${role})`));

  return connection;
}

/** Shared connection for plain commands (rate-limit counters, health checks). */
let sharedConnection: Redis | null = null;

export function getRedis(): Redis {
  sharedConnection ??= createRedisConnection('shared');
  return sharedConnection;
}

export async function assertRedisReachable(): Promise<void> {
  await getRedis().ping();
}

export async function closeRedis(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => undefined);
    sharedConnection = null;
  }
}
