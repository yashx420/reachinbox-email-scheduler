import { Router } from 'express';
import { env } from '../config/env';
import { currentUser, requireAuth } from '../middleware/auth';
import { getEmailById, getEmailStats, listEmails } from '../services/email.service';
import { cancelEmailJob, scheduleCampaign } from '../services/scheduler.service';
import { normalizeRecipients, parseRecipientsText, type Recipient } from '../utils/recipients';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/errors';
import { listEmailsQuerySchema, scheduleCampaignSchema, uuidParamSchema } from './schemas';

export const emailsRouter = Router();

emailsRouter.use(requireAuth);

/**
 * POST /api/emails/schedule
 *
 * Accepts a lead list either pre-parsed (`recipients`) or raw
 * (`recipientsText`, e.g. a pasted CSV) so the endpoint is equally usable from
 * the dashboard and from Postman.
 */
emailsRouter.post(
  '/schedule',
  asyncHandler(async (req, res) => {
    const body = scheduleCampaignSchema.parse(req.body);
    const user = currentUser(req);

    const collected: (string | Recipient)[] = [];
    if (body.recipientsText) collected.push(...parseRecipientsText(body.recipientsText));
    for (const entry of body.recipients ?? []) {
      collected.push(typeof entry === 'string' ? entry : { email: entry.email, name: entry.name ?? null });
    }

    const { recipients, invalid, duplicates } = normalizeRecipients(collected);
    if (recipients.length === 0) {
      throw ApiError.badRequest('No valid email addresses were found in the list.', {
        invalidSamples: invalid.slice(0, 5),
      });
    }

    // A start time in the past would make every job overdue and fire the whole
    // campaign at once; clamp it and tell the caller we did.
    const now = Date.now();
    const requestedStart = body.startAt?.getTime() ?? now;
    const startAt = new Date(Math.max(requestedStart, now));

    const result = await scheduleCampaign({
      userId: user.id,
      name: body.name ?? null,
      subject: body.subject,
      body: body.body,
      startAt,
      delayBetweenEmailsMs: body.delayBetweenEmailsMs ?? env.worker.minDelayBetweenEmailsMs,
      hourlyLimit: body.hourlyLimit ?? env.rateLimit.perSenderPerHour,
      recipients,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    res.status(result.reused ? 200 : 201).json({
      campaign: {
        id: result.campaign.id,
        name: result.campaign.name,
        subject: result.campaign.subject,
        startAt: result.campaign.start_at.toISOString(),
        delayBetweenEmailsMs: result.campaign.delay_between_emails_ms,
        hourlyLimit: result.campaign.hourly_limit,
        totalRecipients: result.campaign.total_recipients,
      },
      scheduledCount: result.scheduledCount,
      firstSendAt: result.firstSendAt?.toISOString() ?? null,
      lastSendAt: result.lastSendAt?.toISOString() ?? null,
      sendersInPool: result.senders,
      startAtAdjusted: requestedStart < now,
      skipped: { invalid: invalid.length, duplicates, invalidSamples: invalid.slice(0, 5) },
      reused: result.reused,
    });
  }),
);

emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = listEmailsQuerySchema.parse(req.query);
    const user = currentUser(req);
    res.json(await listEmails({ userId: user.id, ...params }));
  }),
);

emailsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await getEmailStats(user.id));
  }),
);

emailsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const user = currentUser(req);
    const email = await getEmailById(user.id, id);
    if (!email) throw ApiError.notFound('Email not found.');
    res.json(email);
  }),
);

emailsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const user = currentUser(req);
    const row = await cancelEmailJob(user.id, id);
    res.json({ id: row.id, status: row.status });
  }),
);
