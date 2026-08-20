import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createSender, ensureSenders, listSenders, setSenderActive } from '../services/sender.service';
import { createEtherealAccount, verifySender } from '../services/mailer.service';
import { readUsage } from '../services/ratelimit.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/errors';
import { createSenderSchema, uuidParamSchema } from './schemas';
import type { SenderRow } from '../types/domain';

export const sendersRouter = Router();

sendersRouter.use(requireAuth);

/** Credentials never leave the server. */
function toSenderDto(sender: SenderRow) {
  return {
    id: sender.id,
    label: sender.label,
    host: sender.host,
    port: sender.port,
    fromEmail: sender.from_email,
    fromName: sender.from_name,
    maxEmailsPerHour: sender.max_emails_per_hour,
    webUrl: sender.web_url,
    isActive: sender.is_active,
    createdAt: sender.created_at.toISOString(),
  };
}

sendersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const senders = await listSenders();
    const usage = await readUsage(senders.map((s) => ({ id: s.id, max_emails_per_hour: s.max_emails_per_hour })));
    res.json({
      items: senders.map((sender) => ({
        ...toSenderDto(sender),
        usage: usage.senders[sender.id] ?? { used: 0, limit: 0 },
      })),
      window: {
        startedAt: new Date(usage.windowStart).toISOString(),
        resetsAt: new Date(usage.nextWindowStart).toISOString(),
        windowMs: usage.windowMs,
      },
      global: usage.global,
    });
  }),
);

sendersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSenderSchema.parse(req.body);
    const sender = await createSender(body);
    res.status(201).json(toSenderDto(sender));
  }),
);

/** One-click Ethereal mailbox — the fastest path to a working demo. */
sendersRouter.post(
  '/ethereal',
  asyncHandler(async (req, res) => {
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim()
      : `ethereal-${Date.now()}`;
    const account = await createEtherealAccount(label);
    const sender = await createSender({
      label: account.label,
      host: account.host,
      port: account.port,
      secure: account.secure,
      username: account.user,
      password: account.pass,
      fromEmail: account.user,
      webUrl: account.webUrl,
    });
    res.status(201).json(toSenderDto(sender));
  }),
);

/** Ensures at least one sender exists; safe to call repeatedly. */
sendersRouter.post(
  '/bootstrap',
  asyncHandler(async (_req, res) => {
    const senders = await ensureSenders();
    res.json({ items: senders.map(toSenderDto) });
  }),
);

sendersRouter.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const sender = (await listSenders()).find((item) => item.id === id);
    if (!sender) throw ApiError.notFound('Sender not found.');
    res.json({ id, ok: await verifySender(sender) });
  }),
);

sendersRouter.post(
  '/:id/toggle',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const isActive = Boolean(req.body?.isActive);
    const sender = await setSenderActive(id, isActive);
    if (!sender) throw ApiError.notFound('Sender not found.');
    res.json(toSenderDto(sender));
  }),
);
