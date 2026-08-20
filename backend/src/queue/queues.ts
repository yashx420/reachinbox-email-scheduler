import { Queue } from 'bullmq';
import { env } from '../config/env';
import { createRedisConnection } from '../config/redis';
import type { EmailJobPayload } from '../types/domain';

export const EMAIL_QUEUE_NAME = 'email-send';

let emailQueue: Queue<EmailJobPayload> | null = null;

/**
 * Single delayed-job queue for outbound email. There is deliberately no
 * "poller" or cron anywhere: a job's delivery time *is* its BullMQ delay, and
 * BullMQ keeps the delayed set in Redis so it survives process restarts.
 */
export function getEmailQueue(): Queue<EmailJobPayload> {
  emailQueue ??= new Queue<EmailJobPayload>(EMAIL_QUEUE_NAME, {
    connection: createRedisConnection('queue'),
    prefix: env.queuePrefix,
    defaultJobOptions: {
      attempts: env.delivery.maxAttempts,
      backoff: { type: 'exponential', delay: env.delivery.backoffMs },
      // Keep a rolling window of finished jobs for debugging without letting
      // Redis grow unbounded — Postgres is the durable record.
      removeOnComplete: { age: 60 * 60 * 24, count: 5_000 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });
  return emailQueue;
}

export async function closeQueue(): Promise<void> {
  if (emailQueue) {
    await emailQueue.close();
    emailQueue = null;
  }
}
