import type { PoolClient } from 'pg';
import { env } from '../config/env';
import { queryOne, withTransaction } from '../config/db';
import { enqueueEmailJobs, removeEmailJob } from '../queue/enqueue';
import { listSenders, ensureSenders, pickSender } from './sender.service';
import { ApiError } from '../utils/errors';
import { chunk } from '../utils/chunk';
import { createLogger } from '../utils/logger';
import type { CampaignRow, EmailJobRow, SenderRow } from '../types/domain';
import type { Recipient } from '../utils/recipients';

const log = createLogger('scheduler');

export interface ScheduleCampaignInput {
  userId: string;
  name?: string | null;
  subject: string;
  body: string;
  startAt: Date;
  delayBetweenEmailsMs: number;
  hourlyLimit: number | null;
  recipients: Recipient[];
  idempotencyKey?: string | null;
}

export interface ScheduleCampaignResult {
  campaign: CampaignRow;
  scheduledCount: number;
  firstSendAt: Date | null;
  lastSendAt: Date | null;
  senders: number;
  /** True when the same idempotency key was already used — nothing re-queued. */
  reused: boolean;
}

/**
 * Works out when each email in a campaign should go out.
 *
 * Two constraints combine:
 *  1. a minimum spacing between consecutive sends (`delayMs`), and
 *  2. at most `perWindow` emails inside one rate-limit window.
 *
 * Emails fill window 0 spaced by `delayMs`, then spill into window 1 and so
 * on. `Math.max` keeps the series monotonic when the spacing itself is the
 * binding constraint (e.g. a 5-minute delay with a 500/hour cap).
 *
 * This is only the *plan*: the worker re-checks the live Redis counters before
 * every send, so a plan built from stale assumptions still cannot overshoot.
 */
export function planSendTimes(
  count: number,
  startAtMs: number,
  delayMs: number,
  perWindow: number | null,
  windowMs: number,
): number[] {
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const spaced = startAtMs + index * delayMs;
    if (!perWindow || perWindow <= 0) {
      times.push(spaced);
      continue;
    }
    const windowIndex = Math.floor(index / perWindow);
    const positionInWindow = index % perWindow;
    times.push(Math.max(spaced, startAtMs + windowIndex * windowMs + positionInWindow * delayMs));
  }
  return times;
}

interface InsertedJob {
  id: string;
  campaign_id: string;
  sequence: number;
  scheduled_at: Date;
}

/**
 * One statement per batch via `unnest`, instead of N inserts: scheduling
 * 10 000 recipients stays a handful of round trips.
 *
 * `ON CONFLICT (idempotency_key) DO NOTHING` is the row-level guard against
 * the same recipient being scheduled twice for the same campaign.
 */
async function insertEmailJobs(
  client: PoolClient,
  campaign: CampaignRow,
  recipients: Recipient[],
  sendTimes: number[],
  senders: SenderRow[],
): Promise<InsertedJob[]> {
  const inserted: InsertedJob[] = [];
  const indices = recipients.map((_, index) => index);

  for (const batch of chunk(indices, 1_000)) {
    const senderIds = batch.map((index) => pickSender(senders, index).id);
    const emails = batch.map((index) => recipients[index]!.email);
    const names = batch.map((index) => recipients[index]!.name);
    const sequences = batch.map((index) => index);
    const times = batch.map((index) => new Date(sendTimes[index]!));
    const keys = batch.map((index) => `${campaign.id}:${recipients[index]!.email}`);

    const result = await client.query<InsertedJob>(
      `INSERT INTO email_jobs (
         campaign_id, user_id, sender_id, recipient_email, recipient_name,
         subject, body, sequence, scheduled_at, original_scheduled_at, idempotency_key
       )
       SELECT $1, $2, item.sender_id, item.email, item.name,
              $3, $4, item.sequence, item.scheduled_at, item.scheduled_at, item.key
       FROM unnest($5::uuid[], $6::text[], $7::text[], $8::int[], $9::timestamptz[], $10::text[])
         AS item(sender_id, email, name, sequence, scheduled_at, key)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, campaign_id, sequence, scheduled_at`,
      [
        campaign.id,
        campaign.user_id,
        campaign.subject,
        campaign.body,
        senderIds,
        emails,
        names,
        sequences,
        times,
        keys,
      ],
    );
    inserted.push(...result.rows);
  }

  return inserted;
}

export async function scheduleCampaign(input: ScheduleCampaignInput): Promise<ScheduleCampaignResult> {
  if (input.recipients.length === 0) {
    throw ApiError.badRequest('No valid recipients were found in the uploaded list.');
  }
  if (input.recipients.length > env.delivery.maxRecipientsPerCampaign) {
    throw ApiError.badRequest(
      `A single campaign is limited to ${env.delivery.maxRecipientsPerCampaign} recipients (got ${input.recipients.length}).`,
    );
  }

  let senders = await listSenders(true);
  if (senders.length === 0) senders = await ensureSenders();
  if (senders.length === 0) {
    throw ApiError.unavailable('No active SMTP senders are configured. Run `npm run senders:create`.');
  }

  // Replaying the exact same request (network retry, double-click) must not
  // create a second campaign.
  if (input.idempotencyKey) {
    const existing = await queryOne<CampaignRow>(
      'SELECT * FROM campaigns WHERE user_id = $1 AND idempotency_key = $2',
      [input.userId, input.idempotencyKey],
    );
    if (existing) {
      log.info('Replayed schedule request ignored', { campaignId: existing.id });
      return {
        campaign: existing,
        scheduledCount: existing.total_recipients,
        firstSendAt: existing.start_at,
        lastSendAt: null,
        senders: senders.length,
        reused: true,
      };
    }
  }

  const sendTimes = planSendTimes(
    input.recipients.length,
    input.startAt.getTime(),
    input.delayBetweenEmailsMs,
    input.hourlyLimit,
    env.rateLimit.windowMs,
  );

  const { campaign, jobs } = await withTransaction(async (client) => {
    const created = await client.query<CampaignRow>(
      `INSERT INTO campaigns (user_id, name, subject, body, start_at, delay_between_emails_ms, hourly_limit, total_recipients, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.userId,
        input.name ?? null,
        input.subject,
        input.body,
        input.startAt,
        input.delayBetweenEmailsMs,
        input.hourlyLimit,
        input.recipients.length,
        input.idempotencyKey ?? null,
      ],
    );

    const campaignRow = created.rows[0]!;
    const insertedJobs = await insertEmailJobs(client, campaignRow, input.recipients, sendTimes, senders);

    await client.query('UPDATE campaigns SET total_recipients = $2 WHERE id = $1', [
      campaignRow.id,
      insertedJobs.length,
    ]);
    campaignRow.total_recipients = insertedJobs.length;

    return { campaign: campaignRow, jobs: insertedJobs };
  });

  // Enqueue only after the transaction commits. If the process dies in between,
  // the rows exist with status 'scheduled' and the boot reconciler re-adds them
  // — the failure mode is a late send, never a lost or duplicated one.
  await enqueueEmailJobs(jobs);

  log.info('Campaign scheduled', {
    campaignId: campaign.id,
    recipients: jobs.length,
    startAt: input.startAt.toISOString(),
    delayMs: input.delayBetweenEmailsMs,
    hourlyLimit: input.hourlyLimit,
  });

  return {
    campaign,
    scheduledCount: jobs.length,
    firstSendAt: jobs.length > 0 ? new Date(Math.min(...sendTimes)) : null,
    lastSendAt: jobs.length > 0 ? new Date(Math.max(...sendTimes.slice(0, jobs.length))) : null,
    senders: senders.length,
    reused: false,
  };
}

/**
 * Cancels a single pending email. The DB update is the authority: even if the
 * queue job is already active and cannot be removed, the worker re-reads the
 * row before sending and will skip a cancelled one.
 */
export async function cancelEmailJob(userId: string, emailJobId: string): Promise<EmailJobRow> {
  const row = await queryOne<EmailJobRow>(
    `UPDATE email_jobs
        SET status = 'cancelled'
      WHERE id = $1 AND user_id = $2 AND status IN ('scheduled', 'rate_limited')
      RETURNING *`,
    [emailJobId, userId],
  );

  if (!row) {
    const exists = await queryOne<{ status: string }>(
      'SELECT status FROM email_jobs WHERE id = $1 AND user_id = $2',
      [emailJobId, userId],
    );
    if (!exists) throw ApiError.notFound('Email not found.');
    throw ApiError.conflict(`Email is already ${exists.status} and can no longer be cancelled.`);
  }

  await removeEmailJob(row.id);
  return row;
}

/** Cancels every still-pending email in a campaign. */
export async function cancelCampaign(userId: string, campaignId: string): Promise<number> {
  const rows = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE email_jobs
          SET status = 'cancelled'
        WHERE campaign_id = $1 AND user_id = $2 AND status IN ('scheduled', 'rate_limited')
        RETURNING id`,
      [campaignId, userId],
    );
    return result.rows;
  });

  await Promise.all(rows.map((row) => removeEmailJob(row.id)));
  log.info('Campaign cancelled', { campaignId, cancelled: rows.length });
  return rows.length;
}
