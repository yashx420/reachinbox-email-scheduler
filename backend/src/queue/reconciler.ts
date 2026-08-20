import { env } from '../config/env';
import { query } from '../config/db';
import { chunk } from '../utils/chunk';
import { createLogger, describeError } from '../utils/logger';
import { enqueueEmailJobs, type EnqueueableJob } from './enqueue';
import { getEmailQueue } from './queues';

const log = createLogger('reconciler');

export interface ReconcileReport {
  /** Rows that were stuck in `processing` because a worker died mid-send. */
  released: number;
  /** Pending rows that had no live queue job and were re-added. */
  requeued: number;
  /** Total rows still awaiting delivery after reconciliation. */
  pending: number;
  overdue: number;
}

/**
 * Rebuilds the queue from Postgres on boot.
 *
 * Redis normally keeps the delayed set across restarts (the compose file turns
 * on AOF), so this is usually a no-op. It matters when:
 *   - the process died between COMMIT and enqueue,
 *   - Redis was flushed, replaced, or lost its dump,
 *   - a worker was killed while a job was `active`.
 *
 * Re-adding is safe because the queue job id is the row id: BullMQ ignores an
 * add for a job it already has, and the worker's status check catches anything
 * that slipped through. Nothing is ever "restarted from day 1" — each row
 * keeps its own `scheduled_at`, and only genuinely overdue mail goes out now.
 */
export async function reconcilePendingJobs(): Promise<ReconcileReport> {
  const releasedRows = await query<{ id: string }>(
    `UPDATE email_jobs
        SET status = 'scheduled', locked_at = NULL
      WHERE status = 'processing'
        AND (locked_at IS NULL OR locked_at < now() - ($1::bigint * interval '1 millisecond'))
      RETURNING id`,
    [env.delivery.staleProcessingMs],
  );

  if (releasedRows.length > 0) {
    log.warn('Released orphaned in-flight jobs', { count: releasedRows.length });
  }

  const pendingRows = await query<EnqueueableJob>(
    `SELECT id, campaign_id, sequence, scheduled_at
       FROM email_jobs
      WHERE status IN ('scheduled', 'rate_limited')
      ORDER BY scheduled_at ASC, sequence ASC`,
  );

  const queue = getEmailQueue();
  const missing: EnqueueableJob[] = [];

  for (const batch of chunk(pendingRows, 200)) {
    const jobs = await Promise.all(batch.map((row) => queue.getJob(row.id)));

    await Promise.all(
      batch.map(async (row, index) => {
        const job = jobs[index];
        if (!job) {
          missing.push(row);
          return;
        }
        // A job that already finished cannot fire again, so a pending row
        // pointing at one has to be re-queued from scratch.
        if (job.finishedOn) {
          await job.remove().catch((err) => {
            log.warn('Could not drop finished job before re-queueing', {
              jobId: row.id,
              error: describeError(err),
            });
          });
          missing.push(row);
        }
      }),
    );
  }

  const requeued = await enqueueEmailJobs(missing);
  const now = Date.now();
  const overdue = pendingRows.filter((row) => row.scheduled_at.getTime() <= now).length;

  log.info('Reconciliation complete', {
    released: releasedRows.length,
    requeued,
    pending: pendingRows.length,
    overdue,
  });

  return { released: releasedRows.length, requeued, pending: pendingRows.length, overdue };
}
