import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { query, queryOne } from '../config/db';
import { createRedisConnection } from '../config/redis';
import { sendEmail } from '../services/mailer.service';
import { listSenders, rotateFrom } from '../services/sender.service';
import {
  consumeSendSlot,
  nextWindowStartFor,
  refundSendSlot,
  type RateLimitDecision,
} from '../services/ratelimit.service';
import { reserveSendSlot, sleep } from '../services/pacer.service';
import { createLogger, describeError } from '../utils/logger';
import { EMAIL_QUEUE_NAME } from './queues';
import type { EmailJobPayload, EmailJobRow, SenderRow } from '../types/domain';

const log = createLogger('worker');

/**
 * Longest pacing wait a worker will hold open inside the processor. Beyond
 * this the job goes back on the delayed set, so the job lock is never at risk
 * and other work can use the concurrency slot.
 */
function maxInlineWaitMs(): number {
  return Math.max(15_000, env.worker.minDelayBetweenEmailsMs * 2);
}

export interface ProcessResult {
  status: 'sent' | 'skipped';
  emailJobId: string;
  previewUrl?: string | null;
  reason?: string;
}

/**
 * Claims the row for this attempt.
 *
 * The `status IN (...)` filter is the idempotency gate: a row that is already
 * `sent`, `cancelled` or permanently `failed` returns nothing and the job
 * becomes a no-op. That is what makes a re-delivered job (queue replay,
 * stalled-lock recovery, reconciler re-add) safe.
 */
async function claimJobRow(emailJobId: string): Promise<EmailJobRow | null> {
  return queryOne<EmailJobRow>(
    `UPDATE email_jobs
        SET status = 'processing', locked_at = now()
      WHERE id = $1
        AND status IN ('scheduled', 'rate_limited', 'processing')
      RETURNING *`,
    [emailJobId],
  );
}

interface SlotReservation {
  sender: SenderRow;
  decision: RateLimitDecision;
}

/**
 * Reserves an hourly slot, preferring the sender assigned at schedule time but
 * failing over to any other sender that still has quota — that is the point of
 * running a pool. A global-limit rejection short-circuits: no sender can help.
 */
async function reserveSlot(row: EmailJobRow, senders: SenderRow[]): Promise<SlotReservation | null> {
  for (const sender of rotateFrom(senders, row.sender_id)) {
    const decision = await consumeSendSlot(sender.id, sender.max_emails_per_hour);
    if (decision.allowed) return { sender, decision };
    if (decision.blockedBy === 'global') return null;
  }
  return null;
}

/**
 * How many emails the whole pool may send in one window — the per-sender cap
 * multiplied by the number of mailboxes, never above the global cap. Used to
 * spread deferred jobs across the next window instead of stacking them all on
 * its first millisecond.
 */
function windowCapacity(senderCount: number): number {
  const perSender = env.rateLimit.perSenderPerHour > 0
    ? env.rateLimit.perSenderPerHour * Math.max(senderCount, 1)
    : Number.POSITIVE_INFINITY;
  const global = env.rateLimit.globalPerHour > 0 ? env.rateLimit.globalPerHour : Number.POSITIVE_INFINITY;
  const capacity = Math.min(perSender, global);
  return Number.isFinite(capacity) ? Math.max(1, capacity) : 1;
}

/**
 * Hands a claimed job back to the queue to run at `runAt`, without burning a
 * retry attempt — `moveToDelayed` + `DelayedError` is BullMQ's contract for
 * "not now, try again later".
 */
async function reschedule(
  job: Job<EmailJobPayload>,
  row: EmailJobRow,
  runAt: number,
  status: 'scheduled' | 'rate_limited',
  token?: string,
): Promise<never> {
  await query(
    `UPDATE email_jobs
        SET status = $3,
            scheduled_at = $2,
            defer_count = defer_count + CASE WHEN $3 = 'rate_limited' THEN 1 ELSE 0 END,
            locked_at = NULL
      WHERE id = $1`,
    [row.id, new Date(runAt), status],
  );

  await job.moveToDelayed(runAt, token);
  throw new DelayedError();
}

/**
 * Pushes a rate-limited job into the next window instead of failing it.
 *
 * Order is preserved by deriving the offset from the job's position in its
 * campaign: sequence 0 lands first in the new window, sequence 1 one slot
 * later, and so on. BullMQ drains delayed jobs in timestamp order, so the
 * campaign resumes in the order it was composed.
 */
async function deferToNextWindow(
  job: Job<EmailJobPayload>,
  row: EmailJobRow,
  senderCount: number,
  token?: string,
): Promise<never> {
  const spacing = Math.max(env.worker.minDelayBetweenEmailsMs, 1);
  const runAt = nextWindowStartFor() + (row.sequence % windowCapacity(senderCount)) * spacing;

  log.info('Rate limit hit — deferring to next window', {
    emailJobId: row.id,
    sequence: row.sequence,
    runAt: new Date(runAt).toISOString(),
  });

  return reschedule(job, row, runAt, 'rate_limited', token);
}

/** Records a delivery failure and decides whether it is retryable. */
async function recordFailure(row: EmailJobRow, message: string): Promise<'failed' | 'scheduled'> {
  // `attempts` in the CASE reads the pre-update value, so this is a single
  // atomic "increment and decide" — and it makes Postgres, not BullMQ
  // internals, the authority on when a job is exhausted.
  const updated = await queryOne<{ status: 'failed' | 'scheduled' }>(
    `UPDATE email_jobs
        SET attempts = attempts + 1,
            last_error = $2,
            locked_at = NULL,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'scheduled' END
      WHERE id = $1
      RETURNING status`,
    [row.id, message.slice(0, 1_000), env.delivery.maxAttempts],
  );
  return updated?.status ?? 'failed';
}

export async function processEmailJob(
  job: Job<EmailJobPayload>,
  token?: string,
): Promise<ProcessResult> {
  const { emailJobId } = job.data;

  const row = await claimJobRow(emailJobId);
  if (!row) {
    log.debug('Job already settled — skipping', { emailJobId });
    return { status: 'skipped', emailJobId, reason: 'already_settled' };
  }

  const senders = await listSenders(true);
  if (senders.length === 0) {
    await query(`UPDATE email_jobs SET status = 'scheduled', locked_at = NULL WHERE id = $1`, [row.id]);
    throw new Error('No active SMTP senders are configured');
  }

  const reservation = await reserveSlot(row, senders);
  // `deferToNextWindow` never returns; returning it keeps the narrowing honest
  // instead of reaching for a non-null assertion below.
  if (!reservation) return deferToNextWindow(job, row, senders.length, token);

  const { sender, decision } = reservation;

  // Exact inter-send spacing (see pacer.service.ts). Holding the worker slot
  // for a short wait is what keeps sends evenly spaced; anything longer is
  // handed back to the queue so a concurrency slot is not parked on a sleep.
  const spacingMs = env.worker.minDelayBetweenEmailsMs;
  const sendAt = await reserveSendSlot(spacingMs);
  const waitMs = sendAt - Date.now();

  if (waitMs > maxInlineWaitMs()) {
    await refundSendSlot(sender.id, decision.windowStart, sender.max_emails_per_hour);
    log.debug('Pacing wait too long — returning job to the queue', {
      emailJobId: row.id,
      runAt: new Date(sendAt).toISOString(),
    });
    return reschedule(job, row, sendAt, 'scheduled', token);
  }
  if (waitMs > 0) await sleep(waitMs);

  // The moment the message is handed to SMTP — this is what the minimum-delay
  // guarantee applies to.
  const dispatchedAt = new Date();

  try {
    const result = await sendEmail(sender, {
      to: row.recipient_email,
      toName: row.recipient_name,
      subject: row.subject,
      body: row.body,
    });

    await query(
      `UPDATE email_jobs
          SET status = 'sent', sender_id = $2, dispatched_at = $5, sent_at = now(),
              message_id = $3, preview_url = $4, attempts = attempts + 1,
              last_error = NULL, locked_at = NULL
        WHERE id = $1`,
      [row.id, sender.id, result.messageId, result.previewUrl, dispatchedAt],
    );

    log.info('Email sent', {
      emailJobId: row.id,
      to: row.recipient_email,
      sender: sender.label,
      senderUsed: decision.senderUsed,
      globalUsed: decision.globalUsed,
    });

    return { status: 'sent', emailJobId: row.id, previewUrl: result.previewUrl };
  } catch (err) {
    // The email never left, so hand the hourly slot back before retrying.
    await refundSendSlot(sender.id, decision.windowStart, sender.max_emails_per_hour);

    const message = describeError(err);
    const outcome = await recordFailure(row, message);
    log.warn('Email send failed', { emailJobId: row.id, outcome, error: message });

    if (outcome === 'failed') {
      // Attempts exhausted in the DB — stop BullMQ from retrying as well so
      // the two never disagree.
      throw new UnrecoverableError(message);
    }
    throw err instanceof Error ? err : new Error(message);
  }
}

export function createEmailWorker(): Worker<EmailJobPayload, ProcessResult> {
  const minDelay = env.worker.minDelayBetweenEmailsMs;

  const worker = new Worker<EmailJobPayload, ProcessResult>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: createRedisConnection('worker'),
    prefix: env.queuePrefix,
    concurrency: env.worker.concurrency,
    // BullMQ's limiter lives in Redis, so N worker processes share one budget:
    // at most `rateLimitBurst` sends may *start* per `minDelay` window across
    // the whole fleet. This is the "minimum delay between emails" guarantee.
    ...(minDelay > 0
      ? { limiter: { max: env.worker.rateLimitBurst, duration: minDelay } }
      : {}),
    // Comfortably longer than the SMTP socket timeout so a slow provider does
    // not look like a stalled worker (which would re-deliver the job).
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });

  worker.on('completed', (job, result) => {
    log.debug('Job completed', { jobId: job.id, status: result?.status });
  });

  worker.on('failed', (job, err) => {
    log.warn('Job failed', { jobId: job?.id, attempts: job?.attemptsMade, error: describeError(err) });
  });

  worker.on('error', (err) => {
    log.error('Worker error', { error: describeError(err) });
  });

  log.info('Email worker started', {
    queue: EMAIL_QUEUE_NAME,
    concurrency: env.worker.concurrency,
    minDelayMs: minDelay,
    burst: env.worker.rateLimitBurst,
    maxEmailsPerHour: env.rateLimit.globalPerHour,
    maxEmailsPerHourPerSender: env.rateLimit.perSenderPerHour,
  });

  return worker;
}
