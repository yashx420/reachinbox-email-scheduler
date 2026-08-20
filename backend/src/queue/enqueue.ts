import { chunk } from '../utils/chunk';
import { createLogger, describeError } from '../utils/logger';
import { getEmailQueue } from './queues';
import type { EmailJobPayload } from '../types/domain';

const log = createLogger('queue');

/** Rows only need these fields to be turned into a queue job. */
export interface EnqueueableJob {
  id: string;
  campaign_id: string;
  sequence: number;
  scheduled_at: Date;
}

export function delayFor(scheduledAt: Date, now = Date.now()): number {
  return Math.max(0, scheduledAt.getTime() - now);
}

/**
 * The BullMQ job id *is* the `email_jobs.id`. That single decision buys us:
 *  - idempotent enqueueing (BullMQ ignores an add for an existing id, so a
 *    retried API call or a boot-time reconcile can never double-send), and
 *  - a trivial lookup from a DB row to its queue job and back.
 */
export async function enqueueEmailJobs(rows: EnqueueableJob[], batchSize = 500): Promise<number> {
  if (rows.length === 0) return 0;

  const queue = getEmailQueue();
  const now = Date.now();
  let enqueued = 0;

  for (const batch of chunk(rows, batchSize)) {
    await queue.addBulk(
      batch.map((row) => ({
        name: 'send-email',
        data: {
          emailJobId: row.id,
          campaignId: row.campaign_id,
          sequence: row.sequence,
        } satisfies EmailJobPayload,
        opts: { jobId: row.id, delay: delayFor(row.scheduled_at, now) },
      })),
    );
    enqueued += batch.length;
  }

  log.debug('Enqueued email jobs', { count: enqueued });
  return enqueued;
}

export async function enqueueEmailJob(row: EnqueueableJob): Promise<void> {
  await enqueueEmailJobs([row]);
}

export async function removeEmailJob(emailJobId: string): Promise<boolean> {
  try {
    const job = await getEmailQueue().getJob(emailJobId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch (err) {
    // A job that is mid-execution cannot be removed; the worker's status check
    // will see `cancelled` in Postgres and skip the send anyway.
    log.warn('Could not remove queue job', { emailJobId, error: describeError(err) });
    return false;
  }
}

export async function queueSnapshot(): Promise<Record<string, number>> {
  const counts = await getEmailQueue().getJobCounts(
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
    'paused',
  );
  return counts as Record<string, number>;
}
