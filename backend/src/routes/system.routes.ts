import { Router } from 'express';
import { env } from '../config/env';
import { assertDatabaseReachable } from '../config/db';
import { assertRedisReachable } from '../config/redis';
import { queueSnapshot } from '../queue/enqueue';
import { reconcilePendingJobs } from '../queue/reconciler';
import { readUsage } from '../services/ratelimit.service';
import { listSenders } from '../services/sender.service';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { describeError } from '../utils/logger';

export const systemRouter = Router();

/** Public liveness/readiness probe — used by Docker and by the dashboard banner. */
systemRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const [database, redis] = await Promise.all([
      assertDatabaseReachable().then(() => true).catch(() => false),
      assertRedisReachable().then(() => true).catch(() => false),
    ]);

    const healthy = database && redis;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks: { database, redis },
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

/**
 * Live view of the scheduler: queue depth, the hour's quota usage and the
 * throughput settings actually in force. Powers the dashboard's throughput
 * panel and makes the rate-limiting demo visible.
 */
systemRouter.get(
  '/system/throughput',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const senders = await listSenders();
    const [queue, usage] = await Promise.all([
      queueSnapshot().catch((err) => ({ error: describeError(err) })),
      readUsage(senders.map((s) => ({ id: s.id, max_emails_per_hour: s.max_emails_per_hour }))),
    ]);

    res.json({
      queue,
      config: {
        concurrency: env.worker.concurrency,
        minDelayBetweenEmailsMs: env.worker.minDelayBetweenEmailsMs,
        burstPerWindow: env.worker.rateLimitBurst,
        maxEmailsPerHour: env.rateLimit.globalPerHour,
        maxEmailsPerHourPerSender: env.rateLimit.perSenderPerHour,
        rateLimitWindowMs: env.rateLimit.windowMs,
        maxAttempts: env.delivery.maxAttempts,
      },
      window: {
        startedAt: new Date(usage.windowStart).toISOString(),
        resetsAt: new Date(usage.nextWindowStart).toISOString(),
      },
      global: usage.global,
      senders: senders.map((sender) => ({
        id: sender.id,
        label: sender.label,
        isActive: sender.is_active,
        ...(usage.senders[sender.id] ?? { used: 0, limit: 0 }),
      })),
    });
  }),
);

/** Manual re-run of the boot-time reconciliation (handy in the demo). */
systemRouter.post(
  '/system/reconcile',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await reconcilePendingJobs());
  }),
);
